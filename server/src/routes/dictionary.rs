use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{error::AppError, state::AppState};

#[derive(Serialize)]
pub struct ModeResponse {
    pub mode: &'static str,
}

#[derive(Deserialize)]
pub struct SetModeRequest {
    /// "local" or "jisho"
    pub mode: String,
}

/// GET /dictionary/mode — return current dictionary mode.
pub async fn get_mode(
    State(state): State<Arc<AppState>>,
) -> Json<ModeResponse> {
    Json(ModeResponse { mode: state.dict_mode.name() })
}

/// POST /dictionary/mode — switch dictionary mode at runtime.
pub async fn set_mode(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SetModeRequest>,
) -> Result<Json<ModeResponse>, AppError> {
    match body.mode.as_str() {
        "local" => state.dict_mode.set(true),
        "jisho" => state.dict_mode.set(false),
        other => return Err(AppError::BadRequest(
            format!("unknown mode '{other}': use \"local\" or \"jisho\"")
        )),
    }
    tracing::info!("Dictionary mode switched to '{}'", state.dict_mode.name());
    Ok(Json(ModeResponse { mode: state.dict_mode.name() }))
}
