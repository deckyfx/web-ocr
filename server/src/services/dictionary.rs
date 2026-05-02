use std::{
    collections::HashMap,
    io::{Cursor, Read},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    sync::Arc,
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

// ── DictionaryMode ────────────────────────────────────────────────────────────

/// Shared, runtime-switchable dictionary mode.
/// `true` = local (Jitendex), `false` = remote (Jisho).
#[derive(Clone)]
pub struct DictionaryMode(pub Arc<AtomicBool>);

impl DictionaryMode {
    pub fn new(local: bool) -> Self {
        Self(Arc::new(AtomicBool::new(local)))
    }

    pub fn is_local(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }

    pub fn set(&self, local: bool) {
        self.0.store(local, Ordering::Relaxed);
    }

    pub fn name(&self) -> &'static str {
        if self.is_local() { "local" } else { "jisho" }
    }
}

// ── DictionaryService ─────────────────────────────────────────────────────────

pub struct DictionaryService {
    /// expression → list of term entries (Jitendex / JMdict)
    terms: HashMap<String, Vec<LocalEntry>>,
}

impl DictionaryService {
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
        let svc = tokio::task::spawn_blocking(move || parse_terms(&dir)).await??;

        info!("Jitendex loaded: {} entries", svc.terms.len());
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

/// Recursively flatten Yomitan structured-content to plain text.
fn extract_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr.iter().map(extract_text).collect::<Vec<_>>().join(""),
        Value::Object(obj) => {
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

fn extract_meanings(val: Option<&Value>) -> Vec<String> {
    let Some(arr) = val.and_then(|v| v.as_array()) else { return vec![] };

    arr.iter()
        .map(extract_text)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}
