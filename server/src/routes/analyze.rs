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

/// Which dictionary backend to use for a single request.
#[derive(Debug, serde::Deserialize, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DictMode {
    #[default]
    Local,
    Jisho,
}

#[derive(Deserialize)]
pub struct AnalyzeRequest {
    pub text: String,
    /// Apply manga noise sanitization before tokenizing (default: true).
    #[serde(default = "default_true")]
    pub sanitize: bool,
    /// Dictionary backend: "local" (Jitendex, default if loaded) or "jisho" (remote API).
    #[serde(default)]
    pub mode: DictMode,
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
    pub romaji: String,
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

    // ── 3. Dictionary lookup ─────────────────────────────────────────────────
    // Use local Jitendex when: mode is Local AND the dictionary is available.
    // Fall back to Jisho when Local is requested but unavailable.

    let use_local = body.mode == DictMode::Local && state.dictionary.is_available();
    let definitions = lookup_definitions(&state, &tokens, use_local).await;

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

async fn lookup_definitions(
    state: &AppState,
    tokens: &[TokenInfo],
    use_local: bool,
) -> Vec<Option<JishoEntry>> {
    use std::collections::HashMap;

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
    let reading = first.reading.clone();
    let romaji = kana_to_romaji(&reading);
    Some(JishoEntry {
        word: first.expression.clone(),
        reading,
        romaji,
        meanings: first.meanings.clone(),
        jlpt: first.jlpt.clone(),
        is_common: first.is_common,
    })
}

/// Convert hiragana/katakana to Hepburn romaji.
fn kana_to_romaji(kana: &str) -> String {
    // Compounds must be checked before singles.
    const PAIRS: &[(&str, &str)] = &[
        ("きゃ","kya"),("きゅ","kyu"),("きょ","kyo"),("キャ","kya"),("キュ","kyu"),("キョ","kyo"),
        ("しゃ","sha"),("しゅ","shu"),("しょ","sho"),("シャ","sha"),("シュ","shu"),("ショ","sho"),
        ("ちゃ","cha"),("ちゅ","chu"),("ちょ","cho"),("チャ","cha"),("チュ","chu"),("チョ","cho"),
        ("にゃ","nya"),("にゅ","nyu"),("にょ","nyo"),("ニャ","nya"),("ニュ","nyu"),("ニョ","nyo"),
        ("ひゃ","hya"),("ひゅ","hyu"),("ひょ","hyo"),("ヒャ","hya"),("ヒュ","hyu"),("ヒョ","hyo"),
        ("みゃ","mya"),("みゅ","myu"),("みょ","myo"),("ミャ","mya"),("ミュ","myu"),("ミョ","myo"),
        ("りゃ","rya"),("りゅ","ryu"),("りょ","ryo"),("リャ","rya"),("リュ","ryu"),("リョ","ryo"),
        ("ぎゃ","gya"),("ぎゅ","gyu"),("ぎょ","gyo"),("ギャ","gya"),("ギュ","gyu"),("ギョ","gyo"),
        ("じゃ","ja"), ("じゅ","ju"), ("じょ","jo"), ("ジャ","ja"), ("ジュ","ju"), ("ジョ","jo"),
        ("ぢゃ","ja"), ("ぢゅ","ju"), ("ぢょ","jo"), ("ヂャ","ja"), ("ヂュ","ju"), ("ヂョ","jo"),
        ("びゃ","bya"),("びゅ","byu"),("びょ","byo"),("ビャ","bya"),("ビュ","byu"),("ビョ","byo"),
        ("ぴゃ","pya"),("ぴゅ","pyu"),("ぴょ","pyo"),("ピャ","pya"),("ピュ","pyu"),("ピョ","pyo"),
        ("ふぁ","fa"), ("ふぃ","fi"), ("ふぇ","fe"), ("ふぉ","fo"),
        ("ウィ","wi"), ("ウェ","we"), ("ウォ","wo"),
        ("ヴぁ","va"), ("ヴぃ","vi"), ("ヴ","vu"),  ("ヴぇ","ve"), ("ヴぉ","vo"),
    ];
    const SINGLES: &[(&str, &str)] = &[
        ("あ","a"),  ("い","i"),  ("う","u"),  ("え","e"),  ("お","o"),
        ("ア","a"),  ("イ","i"),  ("ウ","u"),  ("エ","e"),  ("オ","o"),
        ("か","ka"), ("き","ki"), ("く","ku"), ("け","ke"), ("こ","ko"),
        ("カ","ka"), ("キ","ki"), ("ク","ku"), ("ケ","ke"), ("コ","ko"),
        ("さ","sa"), ("し","shi"),("す","su"), ("せ","se"), ("そ","so"),
        ("サ","sa"), ("シ","shi"),("ス","su"), ("セ","se"), ("ソ","so"),
        ("た","ta"), ("ち","chi"),("つ","tsu"),("て","te"), ("と","to"),
        ("タ","ta"), ("チ","chi"),("ツ","tsu"),("テ","te"), ("ト","to"),
        ("な","na"), ("に","ni"), ("ぬ","nu"), ("ね","ne"), ("の","no"),
        ("ナ","na"), ("ニ","ni"), ("ヌ","nu"), ("ネ","ne"), ("ノ","no"),
        ("は","ha"), ("ひ","hi"), ("ふ","fu"), ("へ","he"), ("ほ","ho"),
        ("ハ","ha"), ("ヒ","hi"), ("フ","fu"), ("ヘ","he"), ("ホ","ho"),
        ("ま","ma"), ("み","mi"), ("む","mu"), ("め","me"), ("も","mo"),
        ("マ","ma"), ("ミ","mi"), ("ム","mu"), ("メ","me"), ("モ","mo"),
        ("や","ya"), ("ゆ","yu"), ("よ","yo"),
        ("ヤ","ya"), ("ユ","yu"), ("ヨ","yo"),
        ("ら","ra"), ("り","ri"), ("る","ru"), ("れ","re"), ("ろ","ro"),
        ("ラ","ra"), ("リ","ri"), ("ル","ru"), ("レ","re"), ("ロ","ro"),
        ("わ","wa"), ("ゐ","i"),  ("ゑ","e"),  ("を","o"),
        ("ワ","wa"), ("ヲ","o"),
        ("ん","n"),  ("ン","n"),
        ("が","ga"), ("ぎ","gi"), ("ぐ","gu"), ("げ","ge"), ("ご","go"),
        ("ガ","ga"), ("ギ","gi"), ("グ","gu"), ("ゲ","ge"), ("ゴ","go"),
        ("ざ","za"), ("じ","ji"), ("ず","zu"), ("ぜ","ze"), ("ぞ","zo"),
        ("ザ","za"), ("ジ","ji"), ("ズ","zu"), ("ゼ","ze"), ("ゾ","zo"),
        ("だ","da"), ("ぢ","ji"), ("づ","zu"), ("で","de"), ("ど","do"),
        ("ダ","da"), ("ヂ","ji"), ("ヅ","zu"), ("デ","de"), ("ド","do"),
        ("ば","ba"), ("び","bi"), ("ぶ","bu"), ("べ","be"), ("ぼ","bo"),
        ("バ","ba"), ("ビ","bi"), ("ブ","bu"), ("ベ","be"), ("ボ","bo"),
        ("ぱ","pa"), ("ぴ","pi"), ("ぷ","pu"), ("ぺ","pe"), ("ぽ","po"),
        ("パ","pa"), ("ピ","pi"), ("プ","pu"), ("ペ","pe"), ("ポ","po"),
        ("ー","-"),
    ];

    let lookup = |s: &str| -> Option<&'static str> {
        PAIRS.iter().chain(SINGLES.iter())
            .find(|(k, _)| *k == s)
            .map(|(_, v)| *v)
    };

    let chars: Vec<char> = kana.chars().collect();
    let mut result = String::new();
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];

        // っ/ッ — double the first consonant of the next syllable
        if c == 'っ' || c == 'ッ' {
            i += 1;
            if i >= chars.len() { result.push_str("tsu"); break; }
            let two: String = chars[i..].iter().take(2).collect();
            let one: String = chars[i..].iter().take(1).collect();
            if let Some(r) = lookup(&two) {
                result.push(r.chars().next().unwrap_or('t'));
                result.push_str(r);
                i += 2;
            } else if let Some(r) = lookup(&one) {
                result.push(r.chars().next().unwrap_or('t'));
                result.push_str(r);
                i += 1;
            } else {
                result.push_str("tsu");
            }
            continue;
        }

        // 2-char compound
        if i + 1 < chars.len() {
            let two: String = chars[i..i + 2].iter().collect();
            if let Some(r) = lookup(&two) {
                result.push_str(r);
                i += 2;
                continue;
            }
        }

        // single char
        let one: String = std::iter::once(c).collect();
        result.push_str(lookup(&one).unwrap_or(&one));
        i += 1;
    }

    result
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

    let romaji = kana_to_romaji(&reading);
    Some(JishoEntry { word: word_str, reading, romaji, meanings, jlpt, is_common })
}
