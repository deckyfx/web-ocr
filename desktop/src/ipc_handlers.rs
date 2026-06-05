use deckyfx_dioxus_ipc_bridge::prelude::*;
use serde_json::json;

use crate::{actions, capture, client, state::AppState};

// ── capture/cancel ────────────────────────────────────────────────────────────
// React calls this when the user presses Escape during region selection.

pub struct CancelHandler;

impl RouteHandler for CancelHandler {
    fn handle(&self, _req: &EnrichedRequest) -> Result<IpcResponse, IpcError> {
        AppState::get().window_restore();
        Ok(IpcResponse::ok(json!({ "status": "cancelled" })))
    }
}

// ── capture/start ─────────────────────────────────────────────────────────────

pub struct CaptureStartHandler;

impl RouteHandler for CaptureStartHandler {
    fn handle(&self, _req: &EnrichedRequest) -> Result<IpcResponse, IpcError> {
        eprintln!("DEBUG: CaptureStartHandler::handle called");
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                eprintln!("DEBUG: tokio runtime available, spawning do_capture");
                handle.spawn(actions::do_capture());
            }
            Err(e) => {
                eprintln!("DEBUG: NO tokio runtime: {e}");
            }
        }
        Ok(IpcResponse::ok(json!({ "status": "capturing" })))
    }
}

// ── capture/crop ─────────────────────────────────────────────────────────────

pub struct CropHandler;

impl RouteHandler for CropHandler {
    fn handle(&self, req: &EnrichedRequest) -> Result<IpcResponse, IpcError> {
        let body = req
            .body
            .as_ref()
            .and_then(|b| match b {
                RequestBody::Json(j) => Some(j),
                _ => None,
            })
            .ok_or_else(|| IpcError::BadRequest("Missing JSON body".into()))?;

        let x = body
            .get("x")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| IpcError::BadRequest("Missing x".into()))? as u32;
        let y = body
            .get("y")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| IpcError::BadRequest("Missing y".into()))? as u32;
        let width = body
            .get("width")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| IpcError::BadRequest("Missing width".into()))? as u32;
        let height = body
            .get("height")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| IpcError::BadRequest("Missing height".into()))? as u32;

        let state = AppState::get();
        let png_bytes = {
            let lock = state.last_capture.lock().expect("lock poisoned");
            lock.clone()
                .ok_or_else(|| IpcError::InternalError("No capture available".into()))?
        };

        let server_url = state.config.lock().expect("lock poisoned").server_url.clone();
        tokio::spawn(async move {
            let cropped = match capture::crop_png(&png_bytes, x, y, width, height) {
                Ok(b) => b,
                Err(e) => {
                    state.window_restore();
                    state.emit("capture/error", json!({ "message": format!("Crop failed: {e}") }));
                    return;
                }
            };

            let ocr_res = match client::ocr(&state.client, &server_url, cropped).await {
                Ok(r) => r,
                Err(e) => {
                    state.window_restore();
                    state.emit("capture/error", json!({ "message": format!("OCR failed: {e}") }));
                    return;
                }
            };

            if ocr_res.text.trim().is_empty() {
                state.window_restore();
                state.emit(
                    "capture/error",
                    json!({ "message": "No text detected in the selected region." }),
                );
                return;
            }

            let analyze_res = match client::analyze(&state.client, &server_url, &ocr_res.text).await {
                Ok(r) => r,
                Err(e) => {
                    state.window_restore();
                    state.emit(
                        "capture/error",
                        json!({ "message": format!("Analyze failed: {e}") }),
                    );
                    return;
                }
            };

            state.window_restore();
            state.emit(
                "capture/result",
                json!({
                    "ocr_text":    ocr_res.text,
                    "translation": ocr_res.translation,
                    "tokens":      analyze_res.tokens,
                    "definitions": analyze_res.definitions,
                    "elapsed_ms":  ocr_res.elapsed_ms + analyze_res.elapsed_ms,
                }),
            );
        });

        Ok(IpcResponse::ok(json!({ "status": "processing" })))
    }
}

// ── settings/get ─────────────────────────────────────────────────────────────

pub struct SettingsGetHandler;

impl RouteHandler for SettingsGetHandler {
    fn handle(&self, _req: &EnrichedRequest) -> Result<IpcResponse, IpcError> {
        let state = AppState::get();
        let config = state.config.lock().expect("lock poisoned").clone();
        Ok(IpcResponse::ok(serde_json::to_value(config).unwrap_or_default()))
    }
}

// ── settings/set ─────────────────────────────────────────────────────────────

pub struct SettingsSetHandler;

impl RouteHandler for SettingsSetHandler {
    fn handle(&self, req: &EnrichedRequest) -> Result<IpcResponse, IpcError> {
        let body = req
            .body
            .as_ref()
            .and_then(|b| match b {
                RequestBody::Json(j) => Some(j),
                _ => None,
            })
            .ok_or_else(|| IpcError::BadRequest("Missing JSON body".into()))?;

        let state = AppState::get();
        let mut config = state.config.lock().expect("lock poisoned");

        if let Some(url) = body.get("server_url").and_then(|v| v.as_str()) {
            config.server_url = url.to_string();
        }
        if let Some(hk) = body.get("hotkey").and_then(|v| v.as_str()) {
            config.hotkey = hk.to_string();
        }

        Ok(IpcResponse::ok(json!({ "status": "ok" })))
    }
}
