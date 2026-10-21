//! 列本机已安装的字体族，给设置里的字体下拉用。
//!
//! 平台各走各的路：Windows 用 GDI 枚举（与 Word / VS Code 看到的是同一份家族名），
//! Linux 用 `fc-list`，macOS 用 `system_profiler` 的 JSON。三者都只做「家族名」：
//! 样式（Bold / Italic / Light）不该出现在下拉里。
//!
//! 纯逻辑（解析各平台的输出、整理家族名）都在这里，能单测；起进程放在 `commands.rs`。

use serde_json::Value;

/// 整理成下拉要的样子：去空格、去引号、去重（不分大小写）、按不分大小写的字典序排。
///
/// 保留第一次出现的写法：`"Cascadia Code"` 与 `"cascadia code"` 只留前者。
pub fn normalize(raw: Vec<String>) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for item in raw {
        let name = clean(&item);
        if name.is_empty() {
            continue;
        }
        if seen.iter().any(|kept| kept.eq_ignore_ascii_case(&name)) {
            continue;
        }
        seen.push(name);
    }
    seen.sort_by_key(|name| name.to_ascii_lowercase());
    seen
}

/// 去掉引号与首尾空白；顺带把连续空白压成一个空格（有些字体名里带多余空格）。
fn clean(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches(|c| c == '"' || c == '\'');
    trimmed
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

/// 解析 `fc-list --format "%{family}\n"` 的输出。
///
/// 一行可能给多个家族（逗号分隔，本地化名会排在一起），逐个拆出来交给 [`normalize`]。
pub fn parse_fc_list(stdout: &str) -> Vec<String> {
    let mut families = Vec::new();
    for line in stdout.lines() {
        for part in line.split(',') {
            families.push(part.to_string());
        }
    }
    normalize(families)
}

/// 解析 `system_profiler -json SPFontsDataType` 的输出。
///
/// 这份 JSON 的形状在各版本 macOS 上不完全一样，所以不写死结构：递归找 `family` / `fullname`
/// 这类键的字符串值（`_name` 是字体文件名，不是家族名，不收）。找不到任何家族名就是错误
/// （界面会退回手输框）。
pub fn parse_system_profiler_json(stdout: &str) -> Result<Vec<String>, String> {
    let value: Value = serde_json::from_str(stdout)
        .map_err(|e| format!("system_profiler 的输出无法解析：{e}"))?;
    let mut families = Vec::new();
    collect_families(&value, &mut families);
    let families = normalize(families);
    if families.is_empty() {
        return Err("system_profiler 的输出里没有找到字体家族名".to_string());
    }
    Ok(families)
}

fn collect_families(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, entry) in map {
                let key = key.to_ascii_lowercase();
                if key == "family" || key == "fullname" {
                    if let Some(text) = entry.as_str() {
                        out.push(text.to_string());
                        continue;
                    }
                }
                collect_families(entry, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_families(item, out);
            }
        }
        _ => {}
    }
}

#[cfg(target_os = "windows")]
pub fn enumerate_installed() -> Result<Vec<String>, String> {
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DEFAULT_CHARSET, DeleteDC, EnumFontFamiliesExW, LOGFONTW,
    };

    /// GDI 每个家族回调一次；把家族名塞进 `lparam` 指的 Vec 里，返回 1 让它继续。
    unsafe extern "system" fn collect(
        logfont: *const LOGFONTW,
        _metric: *const windows_sys::Win32::Graphics::Gdi::TEXTMETRICW,
        _font_type: u32,
        lparam: isize,
    ) -> i32 {
        let out = unsafe { &mut *(lparam as *mut Vec<String>) };
        let raw: Vec<u16> = unsafe { &*logfont }
            .lfFaceName
            .iter()
            .take_while(|c| **c != 0)
            .copied()
            .collect();
        if let Ok(name) = String::from_utf16(&raw) {
            // 以 `@` 开头的是同一家族的竖排版本，下拉里不要。
            out.push(name.trim_start_matches('@').to_string());
        }
        1
    }

    // 用 DISPLAY 兼容 DC 枚举：与 Office / VS Code 看到的是同一份家族名。
    let dc = unsafe { CreateCompatibleDC(std::ptr::null_mut()) };
    if dc.is_null() {
        return Err("取不到 GDI 设备上下文".to_string());
    }
    let mut logfont: LOGFONTW = unsafe { std::mem::zeroed() };
    logfont.lfCharSet = DEFAULT_CHARSET;
    let mut families: Vec<String> = Vec::new();
    let listed = unsafe {
        EnumFontFamiliesExW(
            dc,
            &logfont,
            Some(collect),
            &mut families as *mut Vec<String> as isize,
            0,
        )
    };
    unsafe { DeleteDC(dc) };
    if families.is_empty() && listed == 0 {
        return Err("GDI 一个字体家族都没枚举出来".to_string());
    }
    Ok(normalize(families))
}

#[cfg(target_os = "linux")]
pub fn enumerate_installed() -> Result<Vec<String>, String> {
    let output = std::process::Command::new("fc-list")
        .args(["--format", "%{family}\n"])
        .output()
        .map_err(|e| format!("跑 fc-list 失败：{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "fc-list 退出码不是 0：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let families = parse_fc_list(&String::from_utf8_lossy(&output.stdout));
    if families.is_empty() {
        return Err("fc-list 没有列出任何字体".to_string());
    }
    Ok(families)
}

#[cfg(target_os = "macos")]
pub fn enumerate_installed() -> Result<Vec<String>, String> {
    let output = std::process::Command::new("system_profiler")
        .args(["-json", "SPFontsDataType"])
        .output()
        .map_err(|e| format!("跑 system_profiler 失败：{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "system_profiler 退出码不是 0：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse_system_profiler_json(&String::from_utf8_lossy(&output.stdout))
}

/// 列本机已安装的字体族，给设置里的字体下拉用。
///
/// 走 blocking pool：Windows 那次 GDI 枚举是同步的，别占 async worker。
#[tauri::command]
pub async fn fonts_list() -> Result<Vec<String>, String> {
    crate::modules::fs::blocking(enumerate_installed).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_trims_drops_blanks_dedupes_and_sorts() {
        let raw = vec![
            "  Cascadia Code  ".to_string(),
            "".to_string(),
            "   ".to_string(),
            "cascadia code".to_string(),
            "\"JetBrains Mono\"".to_string(),
            "Iosevka".to_string(),
            "iosevka".to_string(),
        ];
        assert_eq!(
            normalize(raw),
            vec![
                "Cascadia Code".to_string(),
                "Iosevka".to_string(),
                "JetBrains Mono".to_string(),
            ]
        );
    }

    #[test]
    fn normalize_squashes_inner_whitespace() {
        assert_eq!(
            normalize(vec!["  Fira   Code  ".to_string()]),
            vec!["Fira Code".to_string()]
        );
    }

    #[test]
    fn parse_fc_list_splits_localized_multi_family_lines() {
        let stdout = "Cascadia Code,Cascadia Code Light\nJetBrains Mono\nIosevka,Iosevka Term\n";
        assert_eq!(
            parse_fc_list(stdout),
            vec![
                "Cascadia Code".to_string(),
                "Cascadia Code Light".to_string(),
                "Iosevka".to_string(),
                "Iosevka Term".to_string(),
                "JetBrains Mono".to_string(),
            ]
        );
    }

    #[test]
    fn parse_fc_list_of_nothing_is_empty_not_an_error() {
        assert!(parse_fc_list("").is_empty());
        assert!(parse_fc_list("\n\n").is_empty());
    }

    #[test]
    fn parse_system_profiler_walks_whatever_shape_it_gets() {
        let stdout = r#"{
          "SPFontsDataType": [
            {"_name": "CascadiaCode.ttf", "family": "Cascadia Code", "style": "Book"},
            {"_name": "Iosevka.ttf", "family": "Iosevka", "style": "Regular"},
            {"family": "cascadia code"}
          ]
        }"#;
        assert_eq!(
            parse_system_profiler_json(stdout).expect("应该能解析"),
            vec!["Cascadia Code".to_string(), "Iosevka".to_string()]
        );
    }

    #[test]
    fn parse_system_profiler_rejects_junk_and_empty_lists() {
        assert!(parse_system_profiler_json("not json").is_err());
        assert!(parse_system_profiler_json(r#"{"SPFontsDataType":[]}"#).is_err());
    }
}
