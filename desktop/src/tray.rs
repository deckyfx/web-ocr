use anyhow::{Context, Result};
use tray_icon::{
    menu::{Menu, MenuEvent, MenuItem},
    TrayIcon, TrayIconBuilder,
};

use crate::actions;

pub struct AppTray {
    _icon: TrayIcon,
    capture_id: tray_icon::menu::MenuId,
}

impl AppTray {
    pub fn build() -> Result<Self> {
        let capture_item = MenuItem::new("Capture (Super+Shift+O)", true, None);
        let quit_item = MenuItem::new("Quit", true, None);

        let capture_id = capture_item.id().clone();

        let menu = Menu::new();
        menu.append(&capture_item).context("menu append capture")?;
        menu.append(&quit_item).context("menu append quit")?;

        let icon = load_icon();
        let tray = TrayIconBuilder::new()
            .with_menu(Box::new(menu))
            .with_tooltip("Web OCR Desktop")
            .with_icon(icon)
            .build()
            .context("Failed to build tray icon")?;

        Ok(Self { _icon: tray, capture_id })
    }

    /// Spawn a blocking thread that fires `do_capture` on tray menu events.
    pub fn spawn_listener(capture_id: tray_icon::menu::MenuId) {
        tokio::task::spawn_blocking(move || {
            let receiver = MenuEvent::receiver();
            loop {
                if let Ok(event) = receiver.recv() {
                    if event.id == capture_id {
                        tokio::runtime::Handle::current()
                            .spawn(actions::do_capture());
                    } else {
                        std::process::exit(0);
                    }
                }
            }
        });
    }

    pub fn capture_id(&self) -> tray_icon::menu::MenuId {
        self.capture_id.clone()
    }
}

fn load_icon() -> tray_icon::Icon {
    let width = 16u32;
    let height = 16u32;
    let rgba: Vec<u8> = (0..width * height)
        .flat_map(|_| [0x89u8, 0xb4, 0xfa, 0xff])
        .collect();
    tray_icon::Icon::from_rgba(rgba, width, height).expect("valid icon")
}
