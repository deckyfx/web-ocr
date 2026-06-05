use anyhow::{Context, Result};
use global_hotkey::{
    hotkey::{Code, HotKey, Modifiers},
    GlobalHotKeyEvent, GlobalHotKeyManager,
};

use crate::actions;

pub struct HotkeyManager {
    _manager: GlobalHotKeyManager,
    pub hotkey_id: u32,
}

impl HotkeyManager {
    /// Register the capture hotkey (Super+Shift+O).
    pub fn register() -> Result<Self> {
        let manager = GlobalHotKeyManager::new().context("Failed to create hotkey manager")?;
        let hotkey = HotKey::new(
            Some(Modifiers::SUPER | Modifiers::SHIFT),
            Code::KeyO,
        );
        let id = hotkey.id();
        manager.register(hotkey).context("Failed to register hotkey Super+Shift+O")?;
        Ok(Self { _manager: manager, hotkey_id: id })
    }

    /// Spawn a blocking thread that fires `do_capture` on each hotkey press.
    pub fn spawn_listener(hotkey_id: u32) {
        tokio::task::spawn_blocking(move || {
            let receiver = GlobalHotKeyEvent::receiver();
            loop {
                if let Ok(event) = receiver.recv() {
                    if event.id == hotkey_id {
                        tokio::runtime::Handle::current()
                            .spawn(actions::do_capture());
                    }
                }
            }
        });
    }
}
