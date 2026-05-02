use serde_json::json;

use crate::{capture, state::AppState};

/// Capture the full screen, send to React for region selection.
pub async fn do_capture() {
    let state = AppState::get();
    eprintln!("DEBUG: do_capture started");
    tracing::info!("do_capture: starting screen grab");

    // Hide the app window so it doesn't appear in the screenshot.
    state.window_set_visible(false);
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    state.emit("capture/start", json!({}));

    let result = tokio::task::spawn_blocking(capture::capture_full_screen).await;

    match result {
        Ok(Ok(b64)) => {
            tracing::info!("do_capture: grab OK, b64 len={}", b64.len());
            if let Ok(raw) =
                base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &b64)
            {
                *state.last_capture.lock().expect("lock") = Some(raw);
            }
            // Go fullscreen before showing the selection overlay.
            state.window_go_fullscreen();
            state.window_set_visible(true);
            state.emit(
                "capture/screenshot",
                json!({ "image": format!("data:image/png;base64,{b64}") }),
            );
        }
        Ok(Err(e)) => {
            tracing::error!("do_capture: grab failed: {e}");
            state.window_set_visible(true);
            state.emit("capture/error", json!({ "message": format!("Capture failed: {e}") }));
        }
        Err(e) => {
            tracing::error!("do_capture: task panicked: {e}");
            state.window_set_visible(true);
            state.emit(
                "capture/error",
                json!({ "message": format!("Capture task panicked: {e}") }),
            );
        }
    }
}
