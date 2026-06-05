mod actions;
mod capture;
mod client;
mod config;
mod hotkey;
mod ipc_handlers;
mod state;
mod tray;

use std::time::Duration;

use deckyfx_dioxus_ipc_bridge::prelude::*;
use deckyfx_dioxus_react_integration::prelude::*;
use dioxus::prelude::*;

use config::Config;
use state::init_state;

const REACT_DIR: Asset = asset!("/assets/react");

fn main() {
    tracing_subscriber::fmt::init();
    let config = Config::default();
    init_state(config);
    dioxus::launch(App);
}

#[component]
fn App() -> Element {
    let bridge = IpcBridge::builder()
        .timeout(Duration::from_secs(60))
        .build();

    let router = use_signal(|| {
        IpcRouter::builder()
            .route("POST", "/capture/start",  Box::new(ipc_handlers::CaptureStartHandler))
            .route("POST", "/capture/crop",   Box::new(ipc_handlers::CropHandler))
            .route("POST", "/capture/cancel", Box::new(ipc_handlers::CancelHandler))
            .route("GET",  "/settings",       Box::new(ipc_handlers::SettingsGetHandler))
            .route("POST", "/settings",       Box::new(ipc_handlers::SettingsSetHandler))
            .build()
    });

    // Store the tao window handle in AppState so background tasks can control it.
    let desktop = dioxus::desktop::window();
    state::AppState::get().window.set(desktop.window.clone()).ok();

    use_effect(move || {
        eprintln!("DEBUG: use_effect running, calling router.start()");
        router.read().start();
        eprintln!("DEBUG: router.start() called");

        // Bridge events from background tokio threads → Dioxus runtime thread.
        // Background tasks call AppState::emit() which sends through this channel;
        // the spawned future runs inside the Dioxus runtime where bridge::emit is valid.
        let (tx, mut rx) =
            tokio::sync::mpsc::unbounded_channel::<(String, serde_json::Value)>();
        *state::AppState::get().event_tx.lock().expect("lock") = Some(tx);

        spawn(async move {
            while let Some((event, data)) = rx.recv().await {
                deckyfx_dioxus_ipc_bridge::bridge::emit(&event, data);
            }
        });

        match hotkey::HotkeyManager::register() {
            Ok(hm) => hotkey::HotkeyManager::spawn_listener(hm.hotkey_id),
            Err(e) => tracing::warn!("Hotkey registration failed: {e}"),
        }

        match tray::AppTray::build() {
            Ok(tray) => {
                let cap_id = tray.capture_id();
                tray::AppTray::spawn_listener(cap_id);
                std::mem::forget(tray);
            }
            Err(e) => tracing::warn!("Tray icon failed: {e}"),
        }
    });

    let manifest = ReactManifest::from_json(include_str!("../assets/react/metadata.json"))
        .expect("invalid metadata.json");

    rsx! {
        ReactApp {
            dir: REACT_DIR,
            manifest: manifest,
            bridge: bridge,
        }
    }
}
