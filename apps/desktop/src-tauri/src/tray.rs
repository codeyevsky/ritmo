//! System tray icon and its transport menu.
//!
//! Menu actions are forwarded through the same `ritmo://media-command` channel
//! as MPRIS, so the frontend has exactly one place that handles external
//! transport requests.

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::state::events;

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Play / Pause", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "Next", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "previous", "Previous", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show Ritmo", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&toggle, &prev, &next, &sep1, &show, &sep2, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            tauri::Error::AssetNotFound("default window icon missing".into())
        })?)
        .tooltip("Ritmo")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu)
        .on_tray_icon_event(on_icon)
        .build(app)?;

    Ok(())
}

fn on_menu<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    match id {
        "show" => reveal(app),
        "quit" => {
            // Let the frontend flush its session state before the process dies.
            let _ = app.emit(events::MEDIA_COMMAND, serde_json::json!({ "type": "quit" }));
            let handle = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(250));
                handle.exit(0);
            });
        }
        "toggle" | "next" | "previous" => {
            let _ = app.emit(events::MEDIA_COMMAND, serde_json::json!({ "type": id }));
        }
        _ => {}
    }
}

fn on_icon<R: Runtime>(tray: &tauri::tray::TrayIcon<R>, event: TrayIconEvent) {
    // Left click toggles visibility, which is what every other tray-resident
    // media player on the desktop does.
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        let app = tray.app_handle();
        match app.get_webview_window("main") {
            Some(w) if w.is_visible().unwrap_or(false) => {
                let _ = w.hide();
            }
            _ => reveal(app),
        }
    }
}

fn reveal<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
