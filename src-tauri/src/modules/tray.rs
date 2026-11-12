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

/// The menu's item ids.
///
/// Ids rather than positions: the menu is rebuilt on every language change, and a handler keyed on
/// where an item sat would answer the wrong question the first time one was reordered.
const MENU_SHOW: &str = "show";
const MENU_SCREENSHOT: &str = "screenshot";
const MENU_QUIT: &str = "quit";

/// What a menu id asks the app to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrayAction {
    Show,
    /// Start a region capture. Reachable while the window is hidden or minimised, which is the
    /// point: the grab reads the screen, so it never needed the app to be in front - only a way to
    /// ask, and a shortcut cannot be typed into a window that does not have the focus.
    Screenshot,
    Quit,
}

/// The action a menu id stands for, or nothing for an id this build does not know.
///
/// Split out so the mapping can be tested: a menu item that ships without a handler is otherwise
/// a click that silently does nothing, which is exactly the kind of thing nobody reports.
fn action_for(id: &str) -> Option<TrayAction> {
    match id {
        MENU_SHOW => Some(TrayAction::Show),
        MENU_SCREENSHOT => Some(TrayAction::Screenshot),
        MENU_QUIT => Some(TrayAction::Quit),
        _ => None,
    }
}

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

/// The tray dot's colour: Tailwind's `red-500`.
///
/// What the tray dot can say, matching what the window's own dots say: a question is blue and
/// a turn that has ended is green. There is deliberately no third colour - "work in flight" is
/// not something worth a dot on an icon nobody is looking at, and there is no red at all.
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TrayDot {
    /// Some session is asking something.
    Asking,
    /// Some session's turn has ended.
    Finished,
}

impl TrayDot {
    /// Tailwind's `sky-500` and `emerald-500`, the same two the window draws.
    fn colour(self) -> [u8; 4] {
        match self {
            TrayDot::Asking => [0x0e, 0xa5, 0xe9, 0xff],
            TrayDot::Finished => [0x10, 0xb9, 0x81, 0xff],
        }
    }
}

/// Paints one filled circle over the icon's top-right corner, in place.
///
/// The tray icon is this app's own window icon - 32x32 on a 96 DPI screen, which the shell
/// then draws at 16x16 - so the radius is a sixth of the shorter side, which survives that
/// downscale as a small dot rather than a blob, and it is inset by one pixel so the shell's
/// own rounding cannot clip it.
pub(crate) fn paint_state_dot(rgba: &mut [u8], width: u32, height: u32, dot: TrayDot) {
    let colour = dot.colour();
    let radius = (width.min(height) / 6) as f32;
    let (centre_x, centre_y) = (width as f32 - radius - 1.0, radius + 1.0);
    for y in 0..height {
        for x in 0..width {
            let (dx, dy) = (x as f32 + 0.5 - centre_x, y as f32 + 0.5 - centre_y);
            if dx * dx + dy * dy > radius * radius {
                continue;
            }
            let at = ((y * width + x) * 4) as usize;
            if let Some(pixel) = rgba.get_mut(at..at + 4) {
                pixel.copy_from_slice(&colour);
            }
        }
    }
}

/// Draws one colour of dot on the tray icon, or clears it.
///
/// The dot is painted onto the app's own icon at run time: it arrives as RGBA, so there is
/// no second asset to keep in step with the first and no decoder to carry. The page calls
/// this only when the answer changes.
#[tauri::command]
pub fn tray_set_dot(app: AppHandle, dot: Option<TrayDot>) -> Result<(), String> {
    let icon = app.default_window_icon().ok_or("no window icon")?;
    let (width, height) = (icon.width(), icon.height());
    let mut rgba = icon.rgba().to_vec();
    if let Some(dot) = dot {
        paint_state_dot(&mut rgba, width, height, dot);
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

fn build_menu(
    app: &AppHandle,
    show: &str,
    screenshot: &str,
    quit: &str,
) -> tauri::Result<Menu<tauri::Wry>> {
    let show_item = MenuItem::with_id(app, MENU_SHOW, show, true, None::<&str>)?;
    let screenshot_item = MenuItem::with_id(app, MENU_SCREENSHOT, screenshot, true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, MENU_QUIT, quit, true, None::<&str>)?;
    Menu::with_items(app, &[&show_item, &screenshot_item, &quit_item])
}

/// Create the tray on the first call, and relabel it on every later one.
///
/// Building it from the frontend's labels rather than at startup keeps a single
/// language in the menu: there is no first paint in the wrong one.
#[tauri::command]
pub fn tray_set_labels(
    app: AppHandle,
    show: String,
    screenshot: String,
    quit: String,
) -> Result<(), String> {
    let menu = build_menu(&app, &show, &screenshot, &quit).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        return tray.set_menu(Some(menu)).map_err(|e| e.to_string());
    }

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        // A left click brings the window back; the menu belongs to the right button.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match action_for(event.id.as_ref()) {
            Some(TrayAction::Show) => focus_main(app),
            // Deliberately without showing the main window first: the picture wanted is the screen
            // behind the app, and bringing the window forward would be a change to what is about to
            // be photographed. The overlay takes the focus on its own.
            Some(TrayAction::Screenshot) => {
                if let Err(error) = crate::modules::screenshot::begin(app) {
                    log::warn!("tray screenshot failed: {error}");
                }
            }
            Some(TrayAction::Quit) => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit(QUIT_EVENT, ());
                }
            }
            None => {}
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
    fn every_menu_item_has_an_action_and_nothing_else_does() {
        // The failure this guards against is silent: an item added to the menu without an entry
        // here is a click that does nothing, which is reported as "the menu is broken" much later.
        assert_eq!(action_for(MENU_SHOW), Some(TrayAction::Show));
        assert_eq!(action_for(MENU_SCREENSHOT), Some(TrayAction::Screenshot));
        assert_eq!(action_for(MENU_QUIT), Some(TrayAction::Quit));
        assert_eq!(action_for(""), None);
        assert_eq!(action_for("screenshots"), None);
        // Three ids, three answers: a duplicate would make one of the items unreachable.
        let ids = [MENU_SHOW, MENU_SCREENSHOT, MENU_QUIT];
        let distinct = ids
            .iter()
            .filter(|id| ids.iter().filter(|other| other == id).count() == 1)
            .count();
        assert_eq!(distinct, ids.len());
    }

    #[test]
    fn the_dot_lands_in_the_top_right_and_leaves_the_rest_alone() {
        let (w, h) = (32u32, 32u32);
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        paint_state_dot(&mut rgba, w, h, TrayDot::Asking);
        let at = |x: u32, y: u32| {
            rgba[((y * w + x) * 4) as usize..((y * w + x) * 4 + 4) as usize].to_vec()
        };
        // Asserted as regions rather than as exact pixels: the radius is meant to be tuned
        // against the control screenshots, and the test should survive that.
        let dot = |p: &[u8]| p[..3] == TrayDot::Asking.colour()[..3] && p[3] == 0xff;
        let top_right = (w - 8..w).flat_map(|x| (1..8).map(move |y| (x, y)));
        assert!(
            top_right.map(|(x, y)| at(x, y)).any(|p| dot(&p)),
            "no dot in the top-right corner"
        );
        assert!(
            at(0, h - 1) == vec![0, 0, 0, 0],
            "the far corner must be untouched"
        );
        // It has to stay in its corner: a radius a third of the side - which is what this was
        // first drawn with, and what looked like a blob on the taskbar - reached well past the
        // middle of the icon.
        let painted = (0..h)
            .flat_map(|y| (0..w).map(move |x| (x, y)))
            .filter(|&(x, y)| dot(&at(x, y)))
            .collect::<Vec<_>>();
        assert!(!painted.is_empty());
        assert!(
            painted.iter().all(|&(x, y)| x >= w - 14 && y <= 14),
            "the dot escaped its corner: {painted:?}"
        );
    }

    #[test]
    fn the_two_dots_are_the_window_own_colours_and_are_not_red() {
        // The icon's dot is read from across a taskbar, so it has to be one of the two the
        // window's own dots use: blue for a question, green for a turn that has ended. Red was
        // there for a day and is gone deliberately.
        let painted = |dot: TrayDot| {
            let (w, h) = (32u32, 32u32);
            let mut rgba = vec![0u8; (w * h * 4) as usize];
            paint_state_dot(&mut rgba, w, h, dot);
            let colours = (0..h)
                .flat_map(|y| (0..w).map(move |x| (x, y)))
                .map(|(x, y)| rgba[((y * w + x) * 4) as usize..][..3].to_vec())
                .filter(|p| p.as_slice() != [0, 0, 0])
                .collect::<Vec<_>>();
            assert!(!colours.is_empty());
            colours
        };
        let asking = painted(TrayDot::Asking);
        assert!(asking.iter().all(|p| p.as_slice() == [0x0e, 0xa5, 0xe9]));
        let finished = painted(TrayDot::Finished);
        assert!(finished.iter().all(|p| p.as_slice() == [0x10, 0xb9, 0x81]));
        assert_ne!(TrayDot::Asking, TrayDot::Finished);
    }
}
