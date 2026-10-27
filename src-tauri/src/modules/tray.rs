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
        // Coming back is the other half of going away: the page is told it can be looked at
        // again, rather than waiting for a focus event Windows does not send here.
        crate::modules::window_presentation::set_window_hidden(app, false);
    }
}

/// The attention colour: Tailwind's `amber-500`, the same one the tab's marker, the tab
/// strip's edge and the bell's count use.
const ATTENTION_DOT: [u8; 4] = [0xf5, 0x9e, 0x0b, 0xff];

/// Paints one filled circle over the icon's top-right corner, in place.
///
/// The tray icon is this app's own window icon - 32x32 on a 96 DPI screen, which the shell
/// then draws at 16x16 - so the radius is a third of the shorter side to survive that
/// downscale, and it is inset by one pixel so the shell's own rounding cannot clip it.
pub(crate) fn paint_attention_dot(rgba: &mut [u8], width: u32, height: u32) {
    let radius = (width.min(height) / 3) as f32;
    let (centre_x, centre_y) = (width as f32 - radius - 1.0, radius + 1.0);
    for y in 0..height {
        for x in 0..width {
            let (dx, dy) = (x as f32 + 0.5 - centre_x, y as f32 + 0.5 - centre_y);
            if dx * dx + dy * dy > radius * radius {
                continue;
            }
            let at = ((y * width + x) * 4) as usize;
            if let Some(pixel) = rgba.get_mut(at..at + 4) {
                pixel.copy_from_slice(&ATTENTION_DOT);
            }
        }
    }
}

/// Draws or clears the waiting dot on the tray icon.
///
/// The dot is painted onto the app's own icon at run time: it arrives as RGBA, so there is
/// no second asset to keep in step with the first and no decoder to carry. The page calls
/// this only when the answer changes.
#[tauri::command]
pub fn tray_set_attention(app: AppHandle, on: bool) -> Result<(), String> {
    let icon = app.default_window_icon().ok_or("no window icon")?;
    let (width, height) = (icon.width(), icon.height());
    let mut rgba = icon.rgba().to_vec();
    if on {
        paint_attention_dot(&mut rgba, width, height);
    }
    app.tray_by_id(TRAY_ID)
        .ok_or_else(|| "no tray icon".to_string())?
        .set_icon(Some(tauri::image::Image::new_owned(rgba, width, height)))
        .map_err(|e| e.to_string())
}

/// Brings the main window back, the way a click on the tray icon does.
///
/// The page asks for this when a system notification is clicked: showing a window the shell
/// cannot focus is not enough to bring it in front, and restoring a minimized one is not in
/// the page's permissions.
#[tauri::command]
pub fn tray_focus_main(app: AppHandle) {
    focus_main(&app);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dot_lands_in_the_top_right_and_leaves_the_rest_alone() {
        let (w, h) = (32u32, 32u32);
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        paint_attention_dot(&mut rgba, w, h);
        let at = |x: u32, y: u32| {
            rgba[((y * w + x) * 4) as usize..((y * w + x) * 4 + 4) as usize].to_vec()
        };
        // Asserted as regions rather than as exact pixels: the radius is meant to be tuned
        // against the control screenshots, and the test should survive that.
        let amber = |p: &[u8]| p[..3] == [0xf5, 0x9e, 0x0b] && p[3] == 0xff;
        let top_right = (w - 8..w).flat_map(|x| (1..8).map(move |y| (x, y)));
        assert!(
            top_right.map(|(x, y)| at(x, y)).any(|p| amber(&p)),
            "no amber in the top-right corner"
        );
        assert!(
            at(0, h - 1) == vec![0, 0, 0, 0],
            "the far corner must be untouched"
        );
    }
}
