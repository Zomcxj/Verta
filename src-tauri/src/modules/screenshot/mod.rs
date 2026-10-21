//! 区域截图：抓整屏 → 覆盖窗口上拖框 → 按选区裁剪、编码、落盘、进剪贴板。
//!
//! 裁剪为什么在后端、而且用抓下来的原始像素：把整屏喂给 asset 协议再用 canvas 裁，跨源会给
//! canvas 打上脏标记，`toBlob` 直接抛；何况来回编解码一趟也掉画质。原始像素就存在这里的状态里，
//! 覆盖窗口显示的只是同一张图的预览文件（收尾时删掉）。

mod capture;
mod encode;
mod geom;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl,
    WebviewWindowBuilder,
};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// 覆盖窗口的 label。建窗、关窗两处用的是同一个名字。
const OVERLAY: &str = "screenshot";
/// 「存好了」告诉主窗口用的频道。
pub const SAVED_EVENT: &str = "screenshot:saved";
/// 「没做成」告诉主窗口用的频道。
pub const FAILED_EVENT: &str = "screenshot:failed";
/// 同一进程里连开几张时，临时预览图不能撞名。
static PREVIEW_SEQ: AtomicU64 = AtomicU64::new(0);

/// 抓下来还没用掉的那一张。
struct Pending {
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    /// 覆盖窗口显示用的预览图，收尾时删掉。
    preview: PathBuf,
}

/// 截图模块的状态：只装「正在选的那一张」。
#[derive(Default)]
pub struct ScreenshotState(Mutex<Option<Pending>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotShot {
    /// 覆盖窗口显示用的预览图，asset 协议直接能读。
    preview_path: String,
    width: u32,
    height: u32,
}

/// 选区：物理像素，相对整张截图左上角。宽高可能是负的（往回拖）。
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
    /// 图存好了、但剪贴板没写进去时的原因。别把「一半成了」说成「全成了」。
    clipboard_error: Option<String>,
}

/// 抓屏并摆好覆盖窗口。主窗口点「截图」时调。
#[tauri::command]
pub async fn screenshot_begin(
    app: AppHandle,
    state: tauri::State<'_, ScreenshotState>,
) -> Result<ScreenshotShot, String> {
    // 先抓再开窗：反过来，覆盖窗口自己就进画面了。
    let shot = capture::capture_virtual_screen()?;
    let png = encode::encode_png(&shot.rgba, shot.width, shot.height)?;
    let preview = preview_path();
    std::fs::write(&preview, &png)
        .map_err(|e| format!("写预览图 {} 失败：{e}", preview.display()))?;

    let shot_info = ScreenshotShot {
        preview_path: preview.to_string_lossy().into_owned(),
        width: shot.width,
        height: shot.height,
    };
    *state.0.lock().unwrap() = Some(Pending {
        rgba: shot.rgba,
        width: shot.width,
        height: shot.height,
        preview,
    });

    // 连点两下按钮时，上一次那个还没收干净的窗口先关掉。
    close_overlay(&app);

    let built = WebviewWindowBuilder::new(&app, OVERLAY, WebviewUrl::App("screenshot.html".into()))
        .title("Screenshot")
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build();
    let window = match built {
        Ok(window) => window,
        Err(e) => {
            clear_pending(&state);
            return Err(format!("开截图窗口失败：{e}"));
        }
    };

    // 覆盖窗口要正好压在整块虚拟桌面上。builder 的 position/inner_size 是逻辑像素，而我们要的是
    // 物理像素（多显示器、副屏在左时逻辑坐标还会被缩放因子带偏），所以建好之后按物理像素再摆一次。
    let placed = window
        .set_position(Position::Physical(PhysicalPosition::new(
            shot.origin.0,
            shot.origin.1,
        )))
        .and_then(|()| window.set_size(Size::Physical(PhysicalSize::new(shot.width, shot.height))));
    if let Err(e) = placed {
        let _ = window.close();
        clear_pending(&state);
        return Err(format!("把截图窗口摆到整屏上失败：{e}"));
    }

    // 正常路径是覆盖窗口等图加载完再自己 show()（这样不闪白）；这里兜一次底：前端万一没跑
    // 起来，也不能让用户点了按钮之后什么都没有。
    let fallback = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_millis(700));
        if let Some(window) = fallback.get_webview_window(OVERLAY) {
            let _ = window.show();
            let _ = window.set_focus();
        }
    });

    Ok(shot_info)
}

/// 覆盖窗口挂载后问一次：这次要显示哪张图。
#[tauri::command]
pub fn screenshot_pending(state: tauri::State<'_, ScreenshotState>) -> Option<ScreenshotShot> {
    state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .map(|pending| ScreenshotShot {
            preview_path: pending.preview.to_string_lossy().into_owned(),
            width: pending.width,
            height: pending.height,
        })
}

/// 拖完框：按选区裁剪、编码、落盘、进剪贴板，然后把「存哪了」告诉主窗口。
#[tauri::command]
pub async fn screenshot_finish(
    app: AppHandle,
    state: tauri::State<'_, ScreenshotState>,
    rect: ScreenshotRect,
) -> Result<ScreenshotSaved, String> {
    let Some(pending) = take_pending(&state) else {
        return Err("没有正在选的截图（截图窗口可能已经关掉了）".into());
    };
    // 不论成不成，这张的预览图都不再需要了。
    let _ = std::fs::remove_file(&pending.preview);
    close_overlay(&app);

    let region = geom::clamp_selection(
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        pending.width,
        pending.height,
    )
    .ok_or_else(|| {
        format!(
            "这块选区没法用（{}×{}，最小 {} 像素）",
            rect.width.abs(),
            rect.height.abs(),
            geom::MIN_SIDE
        )
    })?;
    let pixels = geom::crop_rgba(&pending.rgba, pending.width, pending.height, region)
        .ok_or_else(|| "选区落在画面外了".to_string())?;
    let png = encode::encode_png(&pixels, region.width, region.height)?;

    let dir = screenshots_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录 {} 失败：{e}", dir.display()))?;
    let stamp = capture::now_stamp();
    let name = geom::screenshot_file_name(&stamp, |candidate| dir.join(candidate).exists());
    let path = dir.join(name);
    std::fs::write(&path, &png).map_err(|e| format!("写 {} 失败：{e}", path.display()))?;

    // 存好了再进剪贴板；剪贴板写不进去也不该把「存好了」抹掉，所以两件事分开报。
    let clipboard_error =
        match app
            .clipboard()
            .write_image(&Image::new_owned(pixels, region.width, region.height))
        {
            Ok(()) => None,
            Err(e) => Some(e.to_string()),
        };

    let saved = ScreenshotSaved {
        path: path.to_string_lossy().into_owned(),
        width: region.width,
        height: region.height,
        clipboard_error,
    };
    let _ = app.emit_to("main", SAVED_EVENT, saved.clone());
    Ok(saved)
}

/// 按 Esc、或者点一下没拖：收起覆盖窗口，当没发生过。
#[tauri::command]
pub fn screenshot_cancel(app: AppHandle, state: tauri::State<'_, ScreenshotState>) {
    close_overlay(&app);
    clear_pending(&state);
}

/// 覆盖窗口自己出岔子时（预览图没显示出来之类）把原文交回来。
///
/// 不吭声地消失最糟：用户点了按钮、画面闪一下、什么都没发生，只能猜。
#[tauri::command]
pub fn screenshot_failed(
    app: AppHandle,
    state: tauri::State<'_, ScreenshotState>,
    message: String,
) {
    close_overlay(&app);
    clear_pending(&state);
    let _ = app.emit_to("main", FAILED_EVENT, message);
}

/// 图放哪儿：用户自己的「图片\屏幕截图」。找不到「图片」目录就退回主目录。
fn screenshots_dir() -> Result<PathBuf, String> {
    let base = dirs::picture_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "找不到「图片」目录，也说不上主目录在哪".to_string())?;
    Ok(base.join("Screenshots"))
}

fn preview_path() -> PathBuf {
    let seq = PREVIEW_SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("verta-screenshot-{}-{seq}.png", std::process::id()))
}

fn close_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(OVERLAY) {
        let _ = window.close();
    }
}

fn take_pending(state: &ScreenshotState) -> Option<Pending> {
    state.0.lock().unwrap().take()
}

/// 丢掉这一张，并把预览图删掉。
fn clear_pending(state: &ScreenshotState) {
    if let Some(pending) = take_pending(state) {
        let _ = std::fs::remove_file(pending.preview);
    }
}
