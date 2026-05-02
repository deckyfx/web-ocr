use std::{
    collections::HashMap,
    io::{Cursor, Read},
    path::{Path, PathBuf},
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

#[derive(Debug, Serialize, Clone)]
pub struct KanjiEntry {
    pub kanji: String,
    pub readings: Vec<String>,
    pub meanings: Vec<String>,
    pub jlpt: Option<String>,
    pub grade: Option<u8>,
    pub stroke_count: Option<u8>,
}

#[derive(Debug, Serialize, Clone)]
pub struct NameEntry {
    pub expression: String,
    pub reading: String,
    pub tags: Vec<String>,
    pub meanings: Vec<String>,
}

// ── Download URLs ─────────────────────────────────────────────────────────────

const SOURCES: &[(&str, &str)] = &[
    ("jmdict",   "https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMdict_english_with_examples.zip"),
    ("jmnedict", "https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMnedict.zip"),
    ("kanjidic", "https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/KANJIDIC_english.zip"),
];

// ── DictionaryMode ────────────────────────────────────────────────────────────

/// Shared, runtime-switchable dictionary mode.
/// `true` = local (JMdict), `false` = remote (Jisho).
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
    /// expression → list of term entries (JMdict)
    terms: HashMap<String, Vec<LocalEntry>>,
    /// char → kanji entry (KANJIDIC)
    kanji: HashMap<char, KanjiEntry>,
    /// expression → name entries (JMnedict)
    names: HashMap<String, Vec<NameEntry>>,
}

impl DictionaryService {
    /// Download all dictionaries (if not already cached) and load into memory.
    pub async fn load(dict_dir: &Path) -> anyhow::Result<Self> {
        tokio::fs::create_dir_all(dict_dir).await?;

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()?;

        for (name, url) in SOURCES {
            let marker = dict_dir.join(format!("{name}.done"));
            if marker.exists() {
                info!("Dictionary '{name}' already downloaded — skipping");
                continue;
            }
            info!("Downloading dictionary '{name}' from {url}");
            download_and_extract(&client, url, &dict_dir.join(name)).await
                .with_context(|| format!("failed to download {name}"))?;
            tokio::fs::write(&marker, b"").await?;
            info!("Dictionary '{name}' downloaded and extracted");
        }

        info!("Loading dictionaries into memory…");
        let dict_dir = dict_dir.to_path_buf();
        let svc = tokio::task::spawn_blocking(move || parse_all(&dict_dir))
            .await??;

        info!(
            "Dictionaries loaded: {} terms, {} kanji, {} names",
            svc.terms.len(), svc.kanji.len(), svc.names.len()
        );
        Ok(svc)
    }

    /// Look up a word (dictionary form) in JMdict.
    pub fn lookup(&self, word: &str) -> Option<&[LocalEntry]> {
        self.terms.get(word).map(|v| v.as_slice())
    }

    /// Look up a kanji character in KANJIDIC.
    pub fn lookup_kanji(&self, ch: char) -> Option<&KanjiEntry> {
        self.kanji.get(&ch)
    }

    /// Look up a name in JMnedict.
    pub fn lookup_name(&self, word: &str) -> Option<&[NameEntry]> {
        self.names.get(word).map(|v| v.as_slice())
    }
}

// ── Download & extract ────────────────────────────────────────────────────────

async fn download_and_extract(
    client: &reqwest::Client,
    url: &str,
    out_dir: &Path,
) -> anyhow::Result<()> {
    let bytes = client
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;

    let out_dir = out_dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&out_dir)?;
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
        for i in 0..archive.len() {
            let mut file = archive.by_index(i)?;
            if file.is_dir() { continue; }
            let name = file.name().to_string();
            // Only extract JSON files (skip manifest, css, etc.)
            if !name.ends_with(".json") { continue; }
            let dest = out_dir.join(&name);
            let mut buf = Vec::new();
            file.read_to_end(&mut buf)?;
            std::fs::write(&dest, buf)?;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await?
}

// ── Parsing ───────────────────────────────────────────────────────────────────

fn parse_all(dict_dir: &Path) -> anyhow::Result<DictionaryService> {
    let terms = parse_terms(&dict_dir.join("jmdict"))?;
    let kanji = parse_kanji(&dict_dir.join("kanjidic"))?;
    let names = parse_names(&dict_dir.join("jmnedict"))?;
    Ok(DictionaryService { terms, kanji, names })
}

/// Yomitan term bank row:
/// [expression, reading, def_tags, rules, score, [definitions...], sequence, term_tags]
fn parse_terms(dir: &Path) -> anyhow::Result<HashMap<String, Vec<LocalEntry>>> {
    let mut map: HashMap<String, Vec<LocalEntry>> = HashMap::new();

    for path in term_bank_files(dir, "term_bank") {
        let data = std::fs::read_to_string(&path)
            .with_context(|| format!("read {}", path.display()))?;
        let rows: Vec<Value> = serde_json::from_str(&data)?;

        for row in rows {
            let arr = match row.as_array() { Some(a) => a, None => continue };

            let expression  = str_at(arr, 0);
            let reading     = str_at(arr, 1);
            let def_tags    = str_at(arr, 2);
            let term_tags   = str_at(arr, 7);
            let all_tags    = format!("{def_tags} {term_tags}");

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

    Ok(map)
}

/// Yomitan kanji bank row:
/// [kanji, tags, readings_str, [meanings...], {stats}]
fn parse_kanji(dir: &Path) -> anyhow::Result<HashMap<char, KanjiEntry>> {
    let mut map: HashMap<char, KanjiEntry> = HashMap::new();

    for path in term_bank_files(dir, "kanji_bank") {
        let data = std::fs::read_to_string(&path)
            .with_context(|| format!("read {}", path.display()))?;
        let rows: Vec<Value> = serde_json::from_str(&data)?;

        for row in rows {
            let arr = match row.as_array() { Some(a) => a, None => continue };

            let kanji_str = str_at(arr, 0);
            let ch = kanji_str.chars().next().unwrap_or('\0');
            if ch == '\0' { continue; }

            let tags_str = str_at(arr, 1);
            let tags: Vec<&str> = tags_str.split_whitespace().collect();

            let readings: Vec<String> = arr.get(2)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .split_whitespace()
                .map(String::from)
                .collect();

            let meanings: Vec<String> = arr.get(3)
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();

            let stats = arr.get(4).and_then(|v| v.as_object());

            let jlpt = tags.iter()
                .find(|t| t.starts_with("jlpt-"))
                .map(|s| s.to_string());

            let grade = stats
                .and_then(|s| s.get("grade"))
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u8>().ok());

            let stroke_count = stats
                .and_then(|s| s.get("strokes"))
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u8>().ok());

            map.insert(ch, KanjiEntry {
                kanji: kanji_str,
                readings,
                meanings,
                jlpt,
                grade,
                stroke_count,
            });
        }
    }

    Ok(map)
}

/// JMnedict uses same term bank format but definitions are name type tags + readings.
fn parse_names(dir: &Path) -> anyhow::Result<HashMap<String, Vec<NameEntry>>> {
    let mut map: HashMap<String, Vec<NameEntry>> = HashMap::new();

    for path in term_bank_files(dir, "term_bank") {
        let data = std::fs::read_to_string(&path)
            .with_context(|| format!("read {}", path.display()))?;
        let rows: Vec<Value> = serde_json::from_str(&data)?;

        for row in rows {
            let arr = match row.as_array() { Some(a) => a, None => continue };
            let expression = str_at(arr, 0);
            let reading    = str_at(arr, 1);
            let tags_str   = str_at(arr, 2);
            let tags: Vec<String> = tags_str.split_whitespace().map(String::from).collect();
            let meanings   = extract_meanings(arr.get(5));

            if expression.is_empty() { continue; }

            map.entry(expression.clone()).or_default().push(NameEntry {
                expression,
                reading,
                tags,
                meanings,
            });
        }
    }

    Ok(map)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn term_bank_files(dir: &Path, prefix: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if !dir.exists() {
        warn!("Dictionary directory not found: {}", dir.display());
        return paths;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return paths };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(prefix) && name.ends_with(".json") {
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
            // structured-content: { "type": "structured-content", "content": ... }
            // or plain text node: { "text": "..." }
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
