use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Instant};
use tracing::info;

use crate::{
    db,
    error::AppError,
    sanitize::{clean_manga_text, split_sentences},
    services::{analyze::TokenInfo, dictionary::DictionaryService},
    state::AppState,
};

#[derive(Deserialize)]
pub struct AnalyzeRequest {
    pub text: String,
    /// Apply manga noise sanitization before tokenizing (default: true).
    #[serde(default = "default_true")]
    pub sanitize: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Serialize)]
pub struct AnalyzeResponse {
    pub original: String,
    /// Cleaned text (equal to `original` when `sanitize` is false).
    pub sanitized: String,
    /// Input split into individual sentences on 。！？ boundaries.
    pub sentences: Vec<String>,
    /// Flat token list across all sentences.
    pub tokens: Vec<TokenInfo>,
    /// Per-token Jisho dictionary entries (same order as `tokens`).
    /// `null` when Jisho lookup is disabled or the request fails.
    pub definitions: Vec<Option<JishoEntry>>,
    pub elapsed_ms: u64,
}

/// Minimal representation of a Jisho word entry.
#[derive(Serialize, Clone)]
pub struct JishoEntry {
    pub word: String,
    pub reading: String,
    pub meanings: Vec<String>,
    pub jlpt: Option<String>,
    pub is_common: bool,
}

pub async fn handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AnalyzeRequest>,
) -> Result<Json<AnalyzeResponse>, AppError> {
    if body.text.trim().is_empty() {
        return Err(AppError::BadRequest("text must not be empty".to_string()));
    }

    let start = Instant::now();
    let original = body.text.clone();

    // ── 1. Sanitize ──────────────────────────────────────────────────────────

    let sanitized = if body.sanitize {
        clean_manga_text(&original)
    } else {
        original.clone()
    };

    // ── 2. Sentence split → tokenize each sentence ───────────────────────────

    let sentences = split_sentences(&sanitized);

    // Tokenize all sentences and collect into a flat list
    let tokens: Vec<TokenInfo> = {
        let text_to_tokenize = if sentences.is_empty() {
            sanitized.as_str()
        } else {
            sanitized.as_str()
        };

        tokio::task::spawn_blocking({
            let analyze = Arc::clone(&state.analyze);
            let text = text_to_tokenize.to_string();
            move || analyze.tokenize(&text)
        })
        .await
        .map_err(|e| AppError::OcrFailed(format!("tokenizer task panicked: {e}")))?
        .map_err(|e| AppError::OcrFailed(e.to_string()))?
    };

    // ── 3. Dictionary lookup (local JMdict or remote Jisho) ──────────────────

    let definitions = lookup_definitions(&state, &tokens).await;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    info!(
        "Analyze: {} chars → {} tokens in {elapsed_ms}ms",
        sanitized.chars().count(),
        tokens.len()
    );

    // Log to DB (non-fatal)
    if let Err(e) = db::log_translate(&state.db, &original, &sanitized, "analyze", elapsed_ms).await {
        tracing::warn!("Failed to log analyze to DB: {e}");
    }

    Ok(Json(AnalyzeResponse {
        original,
        sanitized,
        sentences,
        tokens,
        definitions,
        elapsed_ms,
    }))
}

// ── Dictionary dispatch ───────────────────────────────────────────────────────

/// Look up each token's `dictionary_form`, deduplicating by key.
/// Dispatches to local JMdict or remote Jisho based on `state.dict_mode`.
async fn lookup_definitions(
    state: &AppState,
    tokens: &[TokenInfo],
) -> Vec<Option<JishoEntry>> {
    use std::collections::HashMap;

    let use_local = state.dict_mode.is_local();
    let mut cache: HashMap<String, Option<JishoEntry>> = HashMap::new();

    for token in tokens {
        if should_skip(&token.pos) {
            continue;
        }
        let key = token.dictionary_form.clone();
        if !cache.contains_key(&key) {
            let entry = if use_local {
                lookup_local(&state.dictionary, &key)
            } else {
                fetch_jisho(&state.http_client, &key).await
            };
            cache.insert(key, entry);
        }
    }

    tokens
        .iter()
        .map(|t| {
            if should_skip(&t.pos) {
                None
            } else {
                cache.get(&t.dictionary_form).cloned().flatten()
            }
        })
        .collect()
}

/// Convert the first local JMdict entry to the shared `JishoEntry` shape.
fn lookup_local(dict: &DictionaryService, word: &str) -> Option<JishoEntry> {
    let entries = dict.lookup(word)?;
    let first = entries.first()?;
    Some(JishoEntry {
        word: first.expression.clone(),
        reading: first.reading.clone(),
        meanings: first.meanings.clone(),
        jlpt: first.jlpt.clone(),
        is_common: first.is_common,
    })
}

fn should_skip(pos: &str) -> bool {
    matches!(
        pos,
        "助詞" | "助動詞" | "記号" | "補助記号" | "接続詞" | "感動詞"
    )
}

async fn fetch_jisho(client: &reqwest::Client, word: &str) -> Option<JishoEntry> {
    if word.is_empty() {
        return None;
    }

    let url = format!(
        "https://jisho.org/api/v1/search/words?keyword={}",
        urlencoding::encode(word)
    );

    let res = client.get(&url).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }

    let json: serde_json::Value = res.json().await.ok()?;
    let data = json.get("data")?.as_array()?;
    let first = data.first()?;

    // Only return if the first result's slug matches what we searched
    let slug = first.get("slug")?.as_str().unwrap_or("");
    if !slug.contains(word) && !word.contains(slug) {
        // Fuzzy mismatch — probably an unrelated result
    }

    let japanese = first.get("japanese")?.as_array()?.first()?;
    let word_str = japanese
        .get("word")
        .and_then(|v| v.as_str())
        .unwrap_or(word)
        .to_string();
    let reading = japanese
        .get("reading")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let senses = first.get("senses")?.as_array()?;
    let meanings: Vec<String> = senses
        .iter()
        .take(3) // cap at 3 senses
        .filter_map(|s| {
            s.get("english_definitions")?
                .as_array()
                .map(|defs| defs.iter().filter_map(|d| d.as_str()).collect::<Vec<_>>().join(", "))
        })
        .collect();

    let jlpt = first
        .get("jlpt")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let is_common = first
        .get("is_common")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    Some(JishoEntry { word: word_str, reading, meanings, jlpt, is_common })
}
