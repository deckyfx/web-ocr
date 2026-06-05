use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Instant};
use tracing::info;

use crate::{db, error::AppError, routes::ocr::TranslateEngine, state::AppState};

#[derive(Deserialize)]
pub struct TranslateRequest {
    pub text: String,
    /// Translation engine: "none" (default → local), "local", "deepl".
    #[serde(default)]
    pub translate_engine: TranslateEngine,
}

#[derive(Serialize)]
pub struct TranslateResponse {
    pub translation: String,
    pub elapsed_ms: u64,
}

pub async fn handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<TranslateRequest>,
) -> Result<Json<TranslateResponse>, AppError> {
    if body.text.trim().is_empty() {
        return Err(AppError::BadRequest("text must not be empty".to_string()));
    }

    let start = Instant::now();

    let translation = match body.translate_engine {
        // "none" on a dedicated translate endpoint falls back to local
        TranslateEngine::None | TranslateEngine::Local => {
            let state_clone = Arc::clone(&state);
            let text = body.text.clone();
            tokio::task::spawn_blocking(move || state_clone.translate.translate(&text))
                .await
                .map_err(|e| AppError::TranslateFailed(format!("Task panicked: {e}")))?
                .map_err(|e| AppError::TranslateFailed(e.to_string()))?
        }

        TranslateEngine::Deepl => {
            let api_key = state
                .config
                .deepl_api_key
                .as_deref()
                .ok_or_else(|| AppError::TranslateFailed(
                    "DEEPL_API_KEY is not configured on the server".to_string(),
                ))?;

            crate::routes::ocr::deepl_translate(&state.http_client, api_key, &body.text)
                .await
                .map_err(|e| AppError::TranslateFailed(e.to_string()))?
        }
    };

    let elapsed_ms = start.elapsed().as_millis() as u64;
    info!("Translated ({} chars) in {elapsed_ms}ms", body.text.len());

    if let Err(e) =
        db::log_translate(&state.db, &body.text, &translation, "en", elapsed_ms).await
    {
        tracing::warn!("Failed to log translation to DB: {e}");
    }

    Ok(Json(TranslateResponse { translation, elapsed_ms }))
}
