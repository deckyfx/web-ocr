use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub server_url: String,
    pub hotkey: String,
    pub tray_enabled: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server_url: "http://127.0.0.1:3579".to_string(),
            hotkey: "Super+Shift+O".to_string(),
            tray_enabled: true,
        }
    }
}
