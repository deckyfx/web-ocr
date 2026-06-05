use std::{
    collections::HashMap,
    io::{Cursor, Read},
    path::Path,
};

use anyhow::Context;
use serde::Serialize;
use serde_json::Value;
use tracing::{info, warn};

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct LocalEntry {
    pub expression: String,
    pub reading: String,
    pub meanings: Vec<String>,
    pub tags: Vec<String>,
    pub is_common: bool,
    pub jlpt: Option<String>,
}

// ── DictionaryService ─────────────────────────────────────────────────────────

pub struct DictionaryService {
    /// expression → list of term entries (Jitendex / JMdict)
    terms: HashMap<String, Vec<LocalEntry>>,
}

impl DictionaryService {
    /// Create an empty (unavailable) service when the zip is not present.
    pub fn empty() -> Self {
        Self { terms: HashMap::new() }
    }

    /// Returns `true` if Jitendex is loaded and has entries.
    pub fn is_available(&self) -> bool {
        !self.terms.is_empty()
    }

    /// Extract `jitendex-yomitan.zip` from `dict_dir` (once) and load into memory.
    ///
    /// The zip is extracted to `{dict_dir}/extracted/`. A `.done` marker prevents
    /// re-extraction on subsequent starts.
    pub async fn load(dict_dir: &Path) -> anyhow::Result<Self> {
        tokio::fs::create_dir_all(dict_dir).await?;

        let zip_path   = dict_dir.join("jitendex-yomitan.zip");
        let extract_dir = dict_dir.join("extracted");
        let marker     = dict_dir.join("jitendex.done");

        if !zip_path.exists() {
            anyhow::bail!(
                "Jitendex zip not found at {}. \
                 Download it from https://github.com/stephenmk/Jitendex/releases \
                 and place it there.",
                zip_path.display()
            );
        }

        if !marker.exists() {
            info!("Extracting Jitendex…");
            let bytes = tokio::fs::read(&zip_path).await
                .with_context(|| format!("read {}", zip_path.display()))?;
            let out = extract_dir.clone();
            tokio::task::spawn_blocking(move || extract_zip(bytes, &out)).await??;
            tokio::fs::write(&marker, b"").await?;
            info!("Jitendex extracted to {}", extract_dir.display());
        } else {
            info!("Jitendex already extracted — skipping");
        }

        info!("Loading Jitendex into memory…");
        let dir = extract_dir.clone();
        let t0 = std::time::Instant::now();
        let svc = tokio::task::spawn_blocking(move || parse_terms(&dir)).await??;
        info!(
            "✓ Jitendex ready — {} entries loaded in {:.1}s",
            svc.terms.len(),
            t0.elapsed().as_secs_f32()
        );
        Ok(svc)
    }

    /// Look up a word (dictionary form) in Jitendex.
    pub fn lookup(&self, word: &str) -> Option<&[LocalEntry]> {
        self.terms.get(word).map(|v| v.as_slice())
    }
}

// ── Extraction ────────────────────────────────────────────────────────────────

fn extract_zip(bytes: Vec<u8>, out_dir: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(out_dir)?;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        if file.is_dir() { continue; }
        let name = file.name().to_string();
        if !name.ends_with(".json") { continue; }
        let dest = out_dir.join(&name);
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)?;
        std::fs::write(&dest, buf)?;
    }
    Ok(())
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/// Parse all `term_bank_*.json` files from `dir` into a single HashMap.
///
/// Yomitan term bank row:
/// `[expression, reading, def_tags, rules, score, [definitions...], sequence, term_tags]`
fn parse_terms(dir: &Path) -> anyhow::Result<DictionaryService> {
    let mut map: HashMap<String, Vec<LocalEntry>> = HashMap::new();

    for path in term_bank_files(dir) {
        let data = std::fs::read_to_string(&path)
            .with_context(|| format!("read {}", path.display()))?;
        let rows: Vec<Value> = serde_json::from_str(&data)?;

        for row in rows {
            let arr = match row.as_array() { Some(a) => a, None => continue };

            let expression = str_at(arr, 0);
            let reading    = str_at(arr, 1);
            let def_tags   = str_at(arr, 2);
            let term_tags  = str_at(arr, 7);
            let all_tags   = format!("{def_tags} {term_tags}");

            let tags: Vec<String> = all_tags
                .split_whitespace()
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect();

            let is_common = tags.iter().any(|t| {
                matches!(t.as_str(), "news1" | "ichi1" | "spec1" | "spec2" | "gai1")
            });

            let jlpt = tags.iter()
                .find(|t| t.starts_with("jlpt-"))
                .cloned();

            let meanings = extract_meanings(arr.get(5));

            if expression.is_empty() || meanings.is_empty() { continue; }

            map.entry(expression.clone()).or_default().push(LocalEntry {
                expression,
                reading,
                meanings,
                tags,
                is_common,
                jlpt,
            });
        }
    }

    Ok(DictionaryService { terms: map })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn term_bank_files(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();
    if !dir.exists() {
        warn!("Dictionary directory not found: {}", dir.display());
        return paths;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return paths };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("term_bank") && name.ends_with(".json") {
            paths.push(entry.path());
        }
    }
    paths.sort();
    paths
}

fn str_at(arr: &[Value], idx: usize) -> String {
    arr.get(idx)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Recursively flatten a node to plain text, joining siblings with a space.
/// Used only for individual gloss `<li>` content (which may contain ruby, etc.).
fn extract_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        // Join siblings with a space so ruby base+furigana don't run together.
        Value::Array(arr) => arr.iter().map(extract_text).collect::<Vec<_>>().join(" "),
        Value::Object(obj) => {
            // Skip <rt> (ruby furigana) — we only want the base characters.
            if obj.get("tag").and_then(|v| v.as_str()) == Some("rt") {
                return String::new();
            }
            if let Some(c) = obj.get("content") {
                extract_text(c)
            } else if let Some(t) = obj.get("text") {
                extract_text(t)
            } else {
                String::new()
            }
        }
        _ => String::new(),
    }
}

/// data.content values whose subtrees should be skipped entirely.
fn is_skipped_section(data_content: &str) -> bool {
    matches!(
        data_content,
        // metadata / labels
        "part-of-speech-info" | "field-info" | "misc-info" |
        // examples
        "extra-info" | "example-sentence" | "example-sentences" |
        "example-sentence-a" | "example-sentence-b" | "example-keyword" |
        // cross-references
        "xref" | "xref-content" | "xref-glossary" |
        // notes
        "sense-note" | "sense-note-content" | "sense-note-label" | "reference-label" |
        // word forms and attribution
        "forms" | "forms-label" | "attribution"
    )
}

/// Collect individual gloss strings from Yomitan structured-content into `out`.
///
/// Recognises `ul[data.content="glossary"]` and extracts each `<li>` child as
/// a separate string. Skips example sentences, cross-references, and metadata.
fn collect_glosses(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => {
            let s = s.trim().to_string();
            if !s.is_empty() {
                out.push(s);
            }
        }
        Value::Array(arr) => {
            for item in arr {
                collect_glosses(item, out);
            }
        }
        Value::Object(obj) => {
            let data_content = obj
                .get("data")
                .and_then(|d| d.as_object())
                .and_then(|d| d.get("content"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if is_skipped_section(data_content) {
                return;
            }

            // Glossary list — extract each <li> as one meaning string.
            if data_content == "glossary" {
                if let Some(content) = obj.get("content") {
                    extract_li_items(content, out);
                }
                return;
            }

            // Recurse into content or text.
            if let Some(c) = obj.get("content") {
                collect_glosses(c, out);
            } else if let Some(t) = obj.get("text") {
                let s = extract_text(t).trim().to_string();
                if !s.is_empty() {
                    out.push(s);
                }
            }
        }
        _ => {}
    }
}

/// Extract the text of every `<li>` in a glossary content node.
fn extract_li_items(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Array(arr) => {
            for item in arr {
                extract_li_items(item, out);
            }
        }
        Value::Object(obj) => {
            if obj.get("tag").and_then(|v| v.as_str()) == Some("li") {
                if let Some(c) = obj.get("content") {
                    let text = extract_text(c);
                    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
                    if !text.is_empty() {
                        out.push(text);
                    }
                }
            } else if let Some(c) = obj.get("content") {
                extract_li_items(c, out);
            }
        }
        _ => {}
    }
}

fn extract_meanings(val: Option<&Value>) -> Vec<String> {
    let Some(arr) = val.and_then(|v| v.as_array()) else { return vec![] };

    let mut meanings = Vec::new();
    for def in arr {
        match def {
            // Plain-string definition (rare but valid in Yomitan format).
            Value::String(s) => {
                let s = s.trim().to_string();
                if !s.is_empty() {
                    meanings.push(s);
                }
            }
            // Structured-content — extract individual glosses.
            _ => collect_glosses(def, &mut meanings),
        }
    }
    meanings
}
