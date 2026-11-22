//! Pasting what a terminal's own clipboard cannot carry.
//!
//! A terminal paste is text, so an agent that wants an image cannot be given one through pasted
//! bytes. Claude Code binds Ctrl+V to "attach the image on the clipboard", and on Windows Terminal
//! that works because *the terminal* turns the image into a file and pastes the path. This is that
//! step, for this app: the clipboard's image, on disk, as an absolute path.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri_plugin_clipboard_manager::ClipboardExt;

/// Where a pasted clipboard image is written: one directory, so the reader can find and clear them.
fn paste_dir() -> PathBuf {
    std::env::temp_dir().join("verta-paste")
}

/// The file one paste goes to. The clock is an argument rather than read here, so a test can pin it.
fn paste_file(dir: &Path, stamp_ms: u128) -> PathBuf {
    dir.join(format!("clipboard-{stamp_ms}.png"))
}

fn stamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or(0)
}

/// The clipboard's image, written as a PNG in the temp directory, as an absolute path.
///
/// `Ok(None)` when the clipboard holds no image at all: the caller has already tried the text, and
/// "there was nothing to paste" is not a failure to report.
#[tauri::command]
pub fn clipboard_image_path(app: tauri::AppHandle) -> Result<Option<String>, String> {
    // A clipboard without an image is the ordinary case - text, or files copied from a folder - and
    // the plugin answers it with an error rather than an empty image.
    let Ok(image) = app.clipboard().read_image() else {
        return Ok(None);
    };
    let (width, height) = (image.width(), image.height());
    if width == 0 || height == 0 {
        return Ok(None);
    }
    let png = super::screenshot::encode::encode_png(image.rgba(), width, height)?;
    let dir = paste_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建目录 {}：{e}", dir.display()))?;
    let path = paste_file(&dir, stamp_ms());
    std::fs::write(&path, &png).map_err(|e| format!("无法写入 {}：{e}", path.display()))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_one_file_per_paste_under_the_paste_directory() {
        let dir = paste_dir();
        let first = paste_file(&dir, 1_700_000_000_000);
        let second = paste_file(&dir, 1_700_000_000_001);
        assert_eq!(first.parent(), Some(dir.as_path()));
        assert_eq!(first.file_name().unwrap(), "clipboard-1700000000000.png");
        assert_ne!(first, second, "两次粘贴不能写到同一个文件");
    }
}
