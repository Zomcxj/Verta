//! The system tray icon.
//!
//! The main window is frameless, and Windows only gives a taskbar button to a
//! window the shell considers a main window, so the tray is what keeps the app
//! reachable: the close button hides the window instead of ending the process,
//! and this icon brings it back or quits for real. Keeping the process alive is
//! also what keeps the terminals running behind a hidden window.
//!
//! The menu labels arrive from the frontend, which owns the message table, so the
//! menu follows the interface language instead of being hard-coded here.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    AppHandle, Emitter, Manager,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

/// Tray id, so a later call can find and relabel the same icon.
const TRAY_ID: &str = "main";

/// Where the quit request goes. The page decides, because only it knows whether
/// there is unsaved work or a running command to warn about first.
const QUIT_EVENT: &str = "verta:quit-requested";

/// The close handler runs in Rust, while the preference lives in the webview.
/// An atomic keeps the latest value available there without blocking the window
/// event on IPC. It starts enabled, matching the persisted preference default.
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

pub fn should_close_to_tray() -> bool {
    CLOSE_TO_TRAY.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn tray_set_close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::Relaxed);
}

fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn build_menu(app: &AppHandle, show: &str, quit: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let show_item = MenuItem::with_id(app, "show", show, true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", quit, true, None::<&str>)?;
    Menu::with_items(app, &[&show_item, &quit_item])
}

/// Create the tray on the first call, and relabel it on every later one.
///
/// Building it from the frontend's labels rather than at startup keeps a single
/// language in the menu: there is no first paint in the wrong one.
#[tauri::command]
pub fn tray_set_labels(app: AppHandle, show: String, quit: String) -> Result<(), String> {
    let menu = build_menu(&app, &show, &quit).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        return tray.set_menu(Some(menu)).map_err(|e| e.to_string());
    }

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        // A left click brings the window back; the menu belongs to the right button.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => focus_main(app),
            "quit" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit(QUIT_EVENT, ());
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                focus_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(&app).map(|_| ()).map_err(|e| e.to_string())
}

/// Leave for real, once the page has agreed to it.
#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}
