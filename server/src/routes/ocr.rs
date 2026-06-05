use axum::{extract::State, Json};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Instant};
use tracing::info;

use crate::{db, error::AppError, state::AppState};

#[derive(Deserialize, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TranslateEngine {
    #[default]
    None,
    Local,
    Deepl,
}

#[derive(Deserialize)]
pub struct OcrRequest {
    /// Base64-encoded image. Accepts "data:image/...;base64,<data>" or raw base64.
    pub image: String,
    /// Translation engine: "none" (default), "local" (embedded model), "deepl".
    #[serde(default)]
    pub translate_engine: TranslateEngine,
}

#[derive(Serialize)]
pub struct OcrResponse {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
    pub elapsed_ms: u64,
}

pub async fn handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<OcrRequest>,
) -> Result<Json<OcrResponse>, AppError> {
    let start = Instant::now();

    // Decode base64 image
    let b64 = body
        .image
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(&body.image);

    let bytes = STANDARD
        .decode(b64)
        .map_err(|e| AppError::BadRequest(format!("Invalid base64: {e}")))?;

    let img = image::load_from_memory(&bytes)
        .map_err(|e| AppError::BadRequest(format!("Invalid image: {e}")))?;

    // OCR (blocking inference — run on thread pool)
    let state_ocr = Arc::clone(&state);
    let text = tokio::task::spawn_blocking(move || state_ocr.ocr.recognize(&img))
        .await
        .map_err(|e| AppError::OcrFailed(format!("Task panicked: {e}")))?
        .map_err(|e| AppError::OcrFailed(e.to_string()))?;

    let preview: String = text.chars().take(60).collect();
    info!("OCR result ({} chars): {:?}", text.chars().count(), preview);

    // Optional translation
    let translation = if text.is_empty() {
        None
    } else {
        match body.translate_engine {
            TranslateEngine::None => None,

            TranslateEngine::Local => {
                let state_clone = Arc::clone(&state);
                let text_clone = text.clone();
                let t = tokio::task::spawn_blocking(move || {
                    state_clone.translate.translate(&text_clone)
                })
                .await
                .map_err(|e| AppError::TranslateFailed(format!("Task panicked: {e}")))?
                .map_err(|e| AppError::TranslateFailed(e.to_string()))?;
                Some(t)
            }

            TranslateEngine::Deepl => {
                let api_key = state
                    .config
                    .deepl_api_key
                    .as_deref()
                    .ok_or_else(|| AppError::TranslateFailed(
                        "DEEPL_API_KEY is not configured on the server".to_string(),
                    ))?;

                let t = deepl_translate(&state.http_client, api_key, &text)
                    .await
                    .map_err(|e| AppError::TranslateFailed(e.to_string()))?;
                Some(t)
            }
        }
    };

    let elapsed_ms = start.elapsed().as_millis() as u64;

    // Log to DB (non-fatal)
    if let Err(e) = db::log_ocr(&state.db, &text, translation.as_deref(), None, elapsed_ms).await {
        tracing::warn!("Failed to log OCR to DB: {e}");
    }

    Ok(Json(OcrResponse { text, translation, elapsed_ms }))
}

// ── DeepL helper ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct DeepLRequest<'a> {
    text: &'a [&'a str],
    target_lang: &'a str,
}

#[derive(Deserialize)]
struct DeepLResponse {
    translations: Vec<DeepLTranslation>,
}

#[derive(Deserialize)]
struct DeepLTranslation {
    text: String,
}

pub async fn deepl_translate(
    client: &reqwest::Client,
    api_key: &str,
    text: &str,
) -> anyhow::Result<String> {
    let endpoint = if api_key.ends_with(":fx") {
        "https://api-free.deepl.com/v2/translate"
    } else {
        "https://api.deepl.com/v2/translate"
    };

    let res = client
        .post(endpoint)
        .header("Authorization", format!("DeepL-Auth-Key {api_key}"))
        .json(&DeepLRequest { text: &[text], target_lang: "EN" })
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("DeepL request failed: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!(
            "DeepL API error {}: {}",
            status,
            &body[..body.len().min(200)]
        ));
    }

    let data: DeepLResponse = res
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to parse DeepL response: {e}"))?;

    data.translations
        .into_iter()
        .next()
        .map(|t| t.text)
        .ok_or_else(|| anyhow::anyhow!("Empty DeepL response"))
}
