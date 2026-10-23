//! Region screenshots: drag a box on the overlay window → grab the screen when Save
//! is clicked → crop to the selection, encode, write to disk, copy to the clipboard.
//!
//! Why the grab happens on "save" instead of when the screenshot button is clicked:
//!
//! 1. The overlay itself sits on the screen (a grey veil + selection box + handles +
//!    action bar), so the grab must happen after it is hidden, or all of that ends up
//!    in the image. Hence: hide the window → wait until it is really off the screen →
//!    grab.
//! 2. Until then the screen stays live. While dragging, the user sees the screen
//!    itself, matching the feel of the Windows built-in Snipping Tool: only a grey
//!    veil on top, and the actual grab happens on release (here: on Save). Nothing is
//!    frozen, so there is no frozen frame to wait for and the overlay can appear
//!    instantly.
//!
//! Cropping, rounding and encoding all happen in the backend: the frontend only draws
//! and hands back the selection coordinates.

mod capture;
mod encode;
mod geom;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl,
    WebviewWindowBuilder,
};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// Label of the overlay window. Window creation, hiding and event routing all use
/// this one name.
const OVERLAY: &str = "screenshot";
/// "Time to work" — the channel sent to the overlay window. The window is kept
/// alive, so every screenshot starts with this message.
pub const ARMED_EVENT: &str = "screenshot:armed";
/// Channel used to tell the main window "saved".
pub const SAVED_EVENT: &str = "screenshot:saved";
/// Channel used to tell the main window "failed".
pub const FAILED_EVENT: &str = "screenshot:failed";

/// How long to wait after hiding the window before grabbing.
///
/// `hide()` only hands the request to the system and that frame is still on screen;
/// grabbing now would capture the veil, selection box, handles and action bar. A bit
/// over one frame is enough (16 ms at 60 Hz); the cost is a brief moment without the
/// veil — the built-in snipping tool has the same flicker.
const HIDE_SETTLE: Duration = Duration::from_millis(80);

/// The state is one bit: whether a screenshot is currently in progress.
///
/// Much simpler than holding pending pixels — pixels are not kept around (see the
/// module docs); this only stops a stray call (the overlay is long gone but a
/// `finish` arrives anyway) from writing out an image out of nowhere.
#[derive(Default)]
pub struct ScreenshotState(AtomicBool);

/// The selection: physical pixels relative to the top-left of the virtual desktop
/// (i.e. of the overlay window). Width and height may be negative (dragging back).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotRect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotSaved {
    path: String,
    width: u32,
    height: u32,
    /// Why the image was saved but not written to the clipboard. Half a success must
    /// not be reported as a full one.
    clipboard_error: Option<String>,
}

/// "Screenshot" clicked: show the overlay window so the veil comes up immediately.
///
/// This step neither grabs the screen nor writes anything, so nothing pops.
#[tauri::command]
pub async fn screenshot_begin(
    app: AppHandle,
    state: tauri::State<'_, ScreenshotState>,
) -> Result<(), String> {
    // The window is created once and kept (see `ensure_overlay`): a fresh webview has
    // to load its page and boot React, which in practice means a two-to-three second
    // wait per click; kept alive, each screenshot just shows it.
    let window = match ensure_overlay(&app) {
        Ok(window) => window,
        Err(e) => {
            state.0.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };
    state.0.store(true, Ordering::SeqCst);
    // Signal first, then show: leftovers from the previous run — selection, corner
    // radius, error — must be cleared (the window may date from hours ago).
    let _ = app.emit_to(OVERLAY, ARMED_EVENT, ());
    window
        .show()
        .map_err(|e| format!("无法显示截图窗口：{e}"))?;
    window
        .set_focus()
        .map_err(|e| format!("无法聚焦截图窗口：{e}"))?;
    Ok(())
}

/// Save clicked: hide the overlay → wait for it to leave the screen → grab → crop,
/// round the corners, encode, write, copy to the clipboard.
///
/// On failure the overlay comes back: the selection is still there, so the user can
/// adjust it and save again.
#[tauri::command]
pub async fn screenshot_finish(
    app: AppHandle,
    state: tauri::State<'_, ScreenshotState>,
    rect: ScreenshotRect,
    corner_radius: u32,
) -> Result<ScreenshotSaved, String> {
    if !state.0.swap(false, Ordering::SeqCst) {
        return Err("当前没有正在进行的截图".into());
    }

    // Hiding involves a wait and the grab blocks, so the whole sequence moves to a
    // blocking thread instead of occupying the async runtime.
    let task = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            capture_after_hiding(&app, rect, corner_radius, capture::now_stamp())
        })
    };
    let saved = match task.await {
        Ok(result) => result,
        Err(e) => Err(format!("截图任务未能完成：{e}")),
    };

    match saved {
        Ok(saved) => {
            // The overlay is not taken down here: `capture_after_hiding` hides it
            // before the grab and it stays hidden.
            let _ = app.emit_to("main", SAVED_EVENT, saved.clone());
            Ok(saved)
        }
        Err(e) => {
            // Bring it back so the user can keep selecting. Restore the state too, so
            // clicking save again just works.
            state.0.store(true, Ordering::SeqCst);
            show_overlay(&app);
            Err(e)
        }
    }
}

/// Hide the overlay → wait for the compositor to drop it → grab the whole virtual
/// desktop → crop and write.
fn capture_after_hiding(
    app: &AppHandle,
    rect: ScreenshotRect,
    corner_radius: u32,
    stamp: String,
) -> Result<ScreenshotSaved, String> {
    hide_overlay(app);
    std::thread::sleep(HIDE_SETTLE);
    let shot = capture::capture_virtual_screen()?;
    finish_shot(app, &shot, rect, corner_radius, stamp)
}

/// Crop → round corners → encode → write → clipboard. Any real failure is returned
/// as-is and the caller decides how to report it.
fn finish_shot(
    app: &AppHandle,
    shot: &capture::RawShot,
    rect: ScreenshotRect,
    corner_radius: u32,
    stamp: String,
) -> Result<ScreenshotSaved, String> {
    let region = geom::clamp_selection(
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        shot.width,
        shot.height,
    )
    .ok_or_else(|| {
        format!(
            "选区无效（{}×{}，最小 {} 像素）",
            rect.width.abs(),
            rect.height.abs(),
            geom::MIN_SIDE
        )
    })?;
    let pixels = geom::crop_rgba(&shot.rgba, shot.width, shot.height, region)
        .ok_or_else(|| "选区超出画面范围".to_string())?;
    // Rounding makes the four corners transparent, so it has to happen before encoding
    // and before the clipboard — the file and the pasted image must be the same image.
    let mut pixels = pixels;
    geom::apply_corner_radius(&mut pixels, region.width, region.height, corner_radius);
    let png = encode::encode_png(&pixels, region.width, region.height)?;

    let dir = screenshots_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建目录 {}：{e}", dir.display()))?;
    let name = geom::screenshot_file_name(&stamp, |candidate| dir.join(candidate).exists());
    let path = dir.join(name);
    std::fs::write(&path, &png).map_err(|e| format!("无法写入 {}：{e}", path.display()))?;

    // Save first, then the clipboard; a clipboard failure must not erase "saved", so
    // the two are reported separately.
    let clipboard_error =
        match app
            .clipboard()
            .write_image(&Image::new_owned(pixels, region.width, region.height))
        {
            Ok(()) => None,
            Err(e) => Some(e.to_string()),
        };

    Ok(ScreenshotSaved {
        path: path.to_string_lossy().into_owned(),
        width: region.width,
        height: region.height,
        clipboard_error,
    })
}

/// Create or reuse the overlay window and lay it over the whole virtual desktop in
/// physical pixels.
///
/// Reuse is about speed: a fresh webview has to load its page and boot React, i.e. a
/// two-to-three second wait per click; kept alive, each screenshot just shows it.
/// Position and size are recomputed every time, so monitor hot-plugging and
/// resolution changes are followed.
fn ensure_overlay(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    let window = match app.get_webview_window(OVERLAY) {
        Some(existing) => existing,
        None => WebviewWindowBuilder::new(app, OVERLAY, WebviewUrl::App("screenshot.html".into()))
            .title("Screenshot")
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            // Transparent: the screen must show through the window. The veil is a
            // semi-transparent black drawn by the window itself, unpainted pixels are
            // fully transparent, and the user sees the live screen — that is what keeps
            // the screen unfrozen.
            .transparent(true)
            .visible(false)
            .build()
            .map_err(|e| format!("无法创建截图窗口：{e}"))?,
    };
    let screen = capture::virtual_screen_bounds()?;
    window
        .set_position(Position::Physical(PhysicalPosition::new(
            screen.x, screen.y,
        )))
        .and_then(|()| {
            window.set_size(Size::Physical(PhysicalSize::new(
                screen.width,
                screen.height,
            )))
        })
        .map_err(|e| format!("无法将截图窗口铺满整屏：{e}"))?;
    Ok(window)
}

/// Esc or cancel: put the overlay away as if nothing happened (nothing was grabbed,
/// so nothing was produced).
#[tauri::command]
pub fn screenshot_cancel(app: AppHandle, state: tauri::State<'_, ScreenshotState>) {
    state.0.store(false, Ordering::SeqCst);
    hide_overlay(&app);
}

/// Hand back the raw message when the overlay itself fails.
///
/// Vanishing silently is the worst outcome: the user clicks, the screen flashes, and
/// nothing happens — leaving them to guess.
#[tauri::command]
pub fn screenshot_failed(
    app: AppHandle,
    state: tauri::State<'_, ScreenshotState>,
    message: String,
) {
    state.0.store(false, Ordering::SeqCst);
    hide_overlay(&app);
    let _ = app.emit_to("main", FAILED_EVENT, message);
}

/// Where images go: the user's Pictures\Screenshots. Falls back to the home directory
/// when Pictures cannot be located.
fn screenshots_dir() -> Result<PathBuf, String> {
    let base = dirs::picture_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "无法定位「图片」目录或用户主目录".to_string())?;
    Ok(base.join("Screenshots"))
}

/// Show it and take focus: without focus it gets neither Esc nor Enter.
fn show_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(OVERLAY) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Hide rather than close: the webview stays alive, so the next screenshot does not
/// have to load its page again.
fn hide_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(OVERLAY) {
        let _ = window.hide();
    }
}
