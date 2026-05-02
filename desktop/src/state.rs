use std::sync::{Arc, Mutex, OnceLock};

use serde_json::Value;
use tokio::sync::mpsc;

use crate::config::Config;

pub struct AppState {
    pub config: Mutex<Config>,
    pub client: reqwest::Client,
    /// Full-screen PNG bytes from the last capture, held until the user crops.
    pub last_capture: Mutex<Option<Vec<u8>>>,
    /// Sender for emitting bridge events from outside the Dioxus runtime.
    pub event_tx: Mutex<Option<mpsc::UnboundedSender<(String, Value)>>>,
    /// Tao window handle — stored once the Dioxus component mounts.
    pub window: OnceLock<Arc<tao::window::Window>>,
}

impl AppState {
    fn new(config: Config) -> Self {
        Self {
            config: Mutex::new(config),
            client: reqwest::Client::new(),
            last_capture: Mutex::new(None),
            event_tx: Mutex::new(None),
            window: OnceLock::new(),
        }
    }

    pub fn get() -> Arc<AppState> {
        GLOBAL_STATE.get().expect("AppState not initialised").clone()
    }

    /// Send a bridge event through the channel to be emitted on the Dioxus runtime thread.
    pub fn emit(&self, event: impl Into<String>, data: Value) {
        if let Some(tx) = self.event_tx.lock().expect("lock").as_ref() {
            let _ = tx.send((event.into(), data));
        }
    }

    /// Make the window fullscreen and hide decorations (for the selection overlay).
    pub fn window_go_fullscreen(&self) {
        if let Some(w) = self.window.get() {
            w.set_decorations(false);
            w.set_fullscreen(Some(tao::window::Fullscreen::Borderless(None)));
        }
    }

    /// Restore the window to its normal decorated state.
    pub fn window_restore(&self) {
        if let Some(w) = self.window.get() {
            w.set_fullscreen(None);
            w.set_decorations(true);
        }
    }

    /// Hide / show the window (used to exclude it from the screenshot).
    pub fn window_set_visible(&self, visible: bool) {
        if let Some(w) = self.window.get() {
            w.set_visible(visible);
        }
    }
}

static GLOBAL_STATE: OnceLock<Arc<AppState>> = OnceLock::new();

pub fn init_state(config: Config) {
    GLOBAL_STATE
        .set(Arc::new(AppState::new(config)))
        .unwrap_or_else(|_| panic!("AppState already initialised"));
}
