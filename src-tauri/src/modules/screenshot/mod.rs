//! 区域截图：覆盖窗口上拖框 → 点保存那一刻抓屏 → 按选区裁剪、编码、落盘、进剪贴板。
//!
//! 抓屏为什么放在「保存」而不是「点截图按钮」：
//!
//! 1. 覆盖窗口自己就压在屏幕上（一层浅灰 + 选择框 + 把手 + 操作条），抓屏必须发生在它藏起来
//!    之后，否则这些东西会一起进到图里。所以顺序是：藏窗口 → 等它真的从屏幕上消失 → 抓屏。
//! 2. 在那之前屏幕一直是活的。用户框选时看到的就是屏幕本身，跟 Windows 自带的「区域截图」
//!    同一套手感：只压一层浅灰，松手（这里是点保存）那一下才真的抓。不冻屏，也就没有「冻住的
//!    那一下」需要等，覆盖窗口可以立刻亮出来。
//!
//! 裁剪、圆角、编码都在后端做：前端只管画，把选区坐标交回来。

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

/// 覆盖窗口的 label。建窗、藏窗、发事件三处用的是同一个名字。
const OVERLAY: &str = "screenshot";
/// 「该干活了」——发给覆盖窗口的频道。窗口是养着的，每次截图都从这条消息开始。
pub const ARMED_EVENT: &str = "screenshot:armed";
/// 「存好了」告诉主窗口用的频道。
pub const SAVED_EVENT: &str = "screenshot:saved";
/// 「没做成」告诉主窗口用的频道。
pub const FAILED_EVENT: &str = "screenshot:failed";

/// 藏起窗口之后等多久再抓屏。
///
/// `hide()` 只是把请求交给系统，屏幕上那一帧还留着；这时候抓屏会把灰层、选择框、把手、操作条
/// 一起拍进去。一帧多一点就够（60 Hz 下一帧 16 ms），代价是这一小段时间里屏幕会短暂地不带灰层
/// ——自带截图也有这一下。
const HIDE_SETTLE: Duration = Duration::from_millis(80);

/// 状态只有一件事：现在有没有一次正在进行的截图。
///
/// 比「手里存着一份待用的像素」简单得多——像素不再留着了（见文件头的说明），这里只是不让一次
/// 散落的调用（覆盖窗口早收起来了，却又来一次 finish）凭空存出一张图。
#[derive(Default)]
pub struct ScreenshotState(AtomicBool);

/// 选区：物理像素，相对整块虚拟桌面左上角（也就是覆盖窗口的左上角）。宽高可能是负的（往回拖）。
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

/// 点「截图」：把覆盖窗口亮出来，浅灰立刻上来。
///
/// 这一步不抓屏、不落盘，所以快得没有东西可以「弹」。
#[tauri::command]
pub async fn screenshot_begin(
    app: AppHandle,
    state: tauri::State<'_, ScreenshotState>,
) -> Result<(), String> {
    // 窗口建一次就养着（见 `ensure_overlay`）：新建一个 webview 要等它起页面、启动 React，
    // 现实里是点一下按钮等两三秒；养着之后每次只是把它亮出来。
    let window = match ensure_overlay(&app) {
        Ok(window) => window,
        Err(e) => {
            state.0.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };
    state.0.store(true, Ordering::SeqCst);
    // 先叫一声再亮出来：上一次用剩的选区、圆角、报错都得清掉（窗口可能是几小时前那一次留下的）。
    let _ = app.emit_to(OVERLAY, ARMED_EVENT, ());
    window
        .show()
        .map_err(|e| format!("无法显示截图窗口：{e}"))?;
    window
        .set_focus()
        .map_err(|e| format!("无法聚焦截图窗口：{e}"))?;
    Ok(())
}

/// 点了保存：藏起覆盖窗口 → 等它从屏幕上消失 → 抓屏 → 裁剪、抠圆角、编码、落盘、进剪贴板。
///
/// 失败时把覆盖窗口亮回来：选区还在，用户能接着调、接着存。
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

    // 藏窗口之后要等、抓屏也是阻塞的，所以整段挪到阻塞线程上去做，不占着异步运行时。
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
            // 覆盖窗口不在这儿收：`capture_after_hiding` 抓屏之前就把它藏了，之后一直藏着。
            let _ = app.emit_to("main", SAVED_EVENT, saved.clone());
            Ok(saved)
        }
        Err(e) => {
            // 亮回来接着选。状态也放回去，用户直接再点一次保存就行。
            state.0.store(true, Ordering::SeqCst);
            show_overlay(&app);
            Err(e)
        }
    }
}

/// 藏掉覆盖窗口 → 等合成器把它摘下去 → 抓整块虚拟桌面 → 裁剪落盘。
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

/// 裁剪 → 抠圆角 → 编码 → 落盘 → 剪贴板。任何一步真出错都原样返回，由调用方决定怎么交代。
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
    // 圆角是「把四个角抠透明」，所以要在编码之前做，也要在进剪贴板之前做——
    // 存下来的文件和剪贴板里的图得是同一张。
    let mut pixels = pixels;
    geom::apply_corner_radius(&mut pixels, region.width, region.height, corner_radius);
    let png = encode::encode_png(&pixels, region.width, region.height)?;

    let dir = screenshots_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建目录 {}：{e}", dir.display()))?;
    let name = geom::screenshot_file_name(&stamp, |candidate| dir.join(candidate).exists());
    let path = dir.join(name);
    std::fs::write(&path, &png).map_err(|e| format!("无法写入 {}：{e}", path.display()))?;

    // 存好了再进剪贴板；剪贴板写不进去也不该把「存好了」抹掉，所以两件事分开报。
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

/// 建好或复用覆盖窗口，并把它按物理像素压在整块虚拟桌面上。
///
/// 复用是为了「快」：新建一个 webview 要等它起页面、启动 React，现实里就是点一下按钮等两三秒；
/// 养着它之后，每次截图只是把它亮出来。位置与尺寸每次都重算，显示器插拔、分辨率改了也跟着走。
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
            // 透明：屏幕要能从窗口里透出来。那层浅灰是窗口自己画的半透明黑，没被压到的像素就是
            // 全透明，用户看到的是活着的屏幕——这正是「不冻屏」的关键。
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

/// 按 Esc、或者点了取消：收起覆盖窗口，当没发生过（这时还没有抓屏，什么都没产生）。
#[tauri::command]
pub fn screenshot_cancel(app: AppHandle, state: tauri::State<'_, ScreenshotState>) {
    state.0.store(false, Ordering::SeqCst);
    hide_overlay(&app);
}

/// 覆盖窗口自己出岔子时把原文交回来。
///
/// 不吭声地消失最糟：用户点了按钮、画面闪一下、什么都没发生，只能猜。
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

/// 图放哪儿：用户自己的「图片\屏幕截图」。找不到「图片」目录就退回主目录。
fn screenshots_dir() -> Result<PathBuf, String> {
    let base = dirs::picture_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "无法定位「图片」目录或用户主目录".to_string())?;
    Ok(base.join("Screenshots"))
}

/// 亮出来并拿焦点：没有焦点就收不到 Esc 与 Enter。
fn show_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(OVERLAY) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 藏起来而不是关掉：webview 养着，下次截图不用再等它起一遍页面。
fn hide_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(OVERLAY) {
        let _ = window.hide();
    }
}
