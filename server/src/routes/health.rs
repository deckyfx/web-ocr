use axum::{extract::State, Json};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::state::AppState;

pub async fn handler(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "ocr_models_dir": state.config.ocr_models_dir.to_string_lossy(),
        "translate_models_dir": state.config.translate_models_dir.to_string_lossy(),
        "deepl_available": state.config.deepl_api_key.is_some(),
    }))
}
