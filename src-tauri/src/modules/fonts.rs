//! List the installed font families for the font dropdown in settings.
//!
//! Each platform takes its own route: GDI enumeration on Windows (the same family names
//! Word / VS Code see), `fc-list` on Linux, `system_profiler` JSON on macOS. All three
//! yield **family names only**: styles (Bold / Italic / Light) must not appear in the
//! dropdown.
//!
//! The pure logic (parsing each platform's output, tidying the family names) lives here
//! so it can be unit-tested; process spawning lives in `commands.rs`.

use serde_json::Value;

/// Shape the list for the dropdown: trim, drop quotes, dedupe (case-insensitively) and
/// sort case-insensitively.
///
/// The first spelling wins: of `"Cascadia Code"` and `"cascadia code"`, only the former
/// survives.
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

/// Strip quotes and surrounding whitespace, and collapse runs of whitespace into one
/// space (some font names carry extra spaces).
fn clean(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches(|c| c == '"' || c == '\'');
    trimmed
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

/// Parse the output of `fc-list --format "%{family}\n"`.
///
/// A line may list several families (comma separated, localized names grouped together);
/// each is split out and handed to [`normalize`].
pub fn parse_fc_list(stdout: &str) -> Vec<String> {
    let mut families = Vec::new();
    for line in stdout.lines() {
        for part in line.split(',') {
            families.push(part.to_string());
        }
    }
    normalize(families)
}

/// Parse the output of `system_profiler -json SPFontsDataType`.
///
/// Its shape differs between macOS versions, so no structure is hard-coded: the tree is
/// walked recursively for string values under keys like `family` / `fullname` (`_name`
/// is the font file name, not a family, so it is skipped). Finding no family at all is an
/// error (the UI then falls back to a free-text field).
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

    /// GDI calls this once per family; push the name into the Vec behind `lparam` and
    /// return 1 to keep going.
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
            // A leading `@` marks the vertical variant of the same family; leave it out of
            // the dropdown.
            out.push(name.trim_start_matches('@').to_string());
        }
        1
    }

    // Enumerate through a DISPLAY-compatible DC: the same family names Office / VS Code
    // see.
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

/// List the installed font families for the font dropdown in settings.
///
/// Runs on the blocking pool: the GDI enumeration on Windows is synchronous, so it must
/// not hold an async worker.
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
