use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};

// ── Request / Response types ──────────────────────────────────────────────────

#[derive(Serialize)]
struct OcrRequest {
    image: String,
    translate_engine: &'static str,
}

#[derive(Debug, Deserialize)]
pub struct OcrResponse {
    pub text: String,
    pub translation: Option<String>,
    pub elapsed_ms: u64,
}

#[derive(Serialize)]
struct AnalyzeRequest<'a> {
    text: &'a str,
    sanitize: bool,
    mode: &'static str,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TokenInfo {
    pub surface: String,
    pub reading: String,
    pub dictionary_form: String,
    pub pos: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JishoEntry {
    pub word: String,
    pub reading: String,
    pub meanings: Vec<String>,
    pub jlpt: Option<String>,
    pub is_common: bool,
}

#[derive(Debug, Deserialize)]
pub struct AnalyzeResponse {
    pub original: String,
    pub sanitized: String,
    pub sentences: Vec<String>,
    pub tokens: Vec<TokenInfo>,
    pub definitions: Vec<Option<JishoEntry>>,
    pub elapsed_ms: u64,
}

// ── Client helpers ────────────────────────────────────────────────────────────

pub async fn ocr(
    client: &reqwest::Client,
    server_url: &str,
    image_bytes: Vec<u8>,
) -> Result<OcrResponse> {
    let b64 = STANDARD.encode(&image_bytes);
    let url = format!("{server_url}/ocr");
    let res = client
        .post(&url)
        .json(&OcrRequest { image: b64, translate_engine: "none" })
        .send()
        .await
        .context("OCR request failed")?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        anyhow::bail!("OCR error {status}: {body}");
    }

    res.json::<OcrResponse>().await.context("OCR response parse failed")
}

pub async fn analyze(
    client: &reqwest::Client,
    server_url: &str,
    text: &str,
) -> Result<AnalyzeResponse> {
    let url = format!("{server_url}/analyze");
    let res = client
        .post(&url)
        .json(&AnalyzeRequest { text, sanitize: true, mode: "local" })
        .send()
        .await
        .context("Analyze request failed")?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        anyhow::bail!("Analyze error {status}: {body}");
    }

    res.json::<AnalyzeResponse>().await.context("Analyze response parse failed")
}
