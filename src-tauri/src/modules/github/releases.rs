//! Releases 与附件下载的纯逻辑：解析 GitHub 的返回、校验落盘文件名、把临时文件转正。
//!
//! 起 gh 进程、读管道、发进度事件在 `commands.rs`；这里只放能单测的部分。

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use super::types::{RepoRelease, RepoReleaseAsset};

/// 一次进度事件至少攒够这么多字节才发，避免把 IPC 刷爆。
const REPORT_BYTES: u64 = 64 * 1024;
/// 或者至少隔这么久发一次：下载慢的时候进度条也要动。
const REPORT_INTERVAL: Duration = Duration::from_millis(100);

/// 文件名的字符上限。要给它后面的 `.verta-part` 和用户选的目录留出余量。
const MAX_NAME_CHARS: usize = 180;

/// Windows 不能当文件名用的设备名（不分大小写，带扩展名也算）。
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 解析 `repos/{owner}/{repo}/releases` 的 JSON。
///
/// 逐条容错：缺 id / tag 的条目跳过，其余字段缺了按空处理。但如果返回里本来有条目、
/// 最后一个都没留下，那是解析失败，不能报成「没有 Release」。
pub fn parse_releases(stdout: &str, limit: usize) -> Result<Vec<RepoRelease>, String> {
    let value: Value = serde_json::from_str(stdout).map_err(|e| format!("JSON 解析失败：{e}"))?;
    let items = value
        .as_array()
        .ok_or_else(|| "返回的不是 Release 数组".to_string())?;

    let mut releases = Vec::new();
    for item in items {
        if releases.len() >= limit {
            break;
        }
        if let Some(release) = convert_release(item) {
            releases.push(release);
        }
    }
    if !items.is_empty() && releases.is_empty() {
        return Err(format!("返回了 {} 条 Release，一条都解析不了", items.len()));
    }
    Ok(releases)
}

fn convert_release(value: &Value) -> Option<RepoRelease> {
    let id = number_field(value, "id")?;
    let tag_name = text_field(value, "tag_name")?;
    // 标题为空（老数据里常见）时用 tag 兜底，界面不用再判一次。
    let name = text_field(value, "name").unwrap_or_else(|| tag_name.clone());
    let body = text_field(value, "body").unwrap_or_default();
    let assets = value
        .get("assets")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(convert_asset).collect())
        .unwrap_or_default();

    Some(RepoRelease {
        id,
        tag_name,
        name,
        body,
        draft: value.get("draft").and_then(Value::as_bool).unwrap_or(false),
        prerelease: value
            .get("prerelease")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        created_at: text_field(value, "created_at"),
        published_at: text_field(value, "published_at"),
        html_url: text_field(value, "html_url").unwrap_or_default(),
        assets,
    })
}

fn convert_asset(value: &Value) -> Option<RepoReleaseAsset> {
    Some(RepoReleaseAsset {
        id: number_field(value, "id")?,
        name: text_field(value, "name")?,
        size: number_field(value, "size").unwrap_or(0),
        download_count: number_field(value, "download_count").unwrap_or(0),
        content_type: text_field(value, "content_type"),
        updated_at: text_field(value, "updated_at"),
    })
}

/// 非空的字符串字段；null / 空串 / 纯空白 / 非字符串一律算没有。
fn text_field(value: &Value, key: &str) -> Option<String> {
    let raw = value.get(key)?.as_str()?.trim();
    (!raw.is_empty()).then(|| raw.to_string())
}

/// 数字字段。GitHub 的 id 有时是数字、有时是字符串，两种都认。
fn number_field(value: &Value, key: &str) -> Option<u64> {
    let raw = value.get(key)?;
    if let Some(number) = raw.as_u64() {
        return Some(number);
    }
    raw.as_str()?.trim().parse().ok()
}

/// 附件名要能安全地拼进用户选的目录：只允许一个普通文件名，不允许任何路径语义。
pub fn safe_file_name(raw: &str) -> Result<String, String> {
    if raw.trim().is_empty() {
        return Err("附件名是空的".to_string());
    }
    if raw.trim() != raw {
        return Err(format!("附件名两端不能有空白：{raw:?}"));
    }
    if raw.chars().count() > MAX_NAME_CHARS {
        return Err(format!("附件名超过 {MAX_NAME_CHARS} 个字符，拒绝写入"));
    }
    if raw.contains('/') || raw.contains('\\') {
        return Err(format!("附件名里不能有路径分隔符：{raw}"));
    }
    if raw == "." || raw == ".." {
        return Err(format!("附件名不能是 {raw}"));
    }
    if raw.chars().any(char::is_control) {
        return Err("附件名里有控制字符，拒绝写入".to_string());
    }
    if raw.ends_with('.') || raw.ends_with(' ') {
        return Err(format!("附件名不能以点或空格结尾：{raw:?}"));
    }
    let stem = raw.split('.').next().unwrap_or(raw).to_ascii_uppercase();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        return Err(format!("附件名是 Windows 保留设备名，拒绝写入：{raw}"));
    }
    Ok(raw.to_string())
}

/// 这一块数据到没到该报进度的程度。
pub fn should_report(last_written: u64, written: u64, since: Duration) -> bool {
    written.saturating_sub(last_written) >= REPORT_BYTES || since >= REPORT_INTERVAL
}

/// 下载收尾：成功才把临时文件转正，失败只清临时文件。
///
/// 既有目标文件永远不参与失败清理：重复下载同名附件失败时，上一次的完整文件必须还在。
pub fn finish_download(tmp: &Path, dest: &Path, ok: bool) -> std::io::Result<()> {
    if !ok {
        let _ = fs::remove_file(tmp);
        return Ok(());
    }
    if let Err(error) = fs::rename(tmp, dest) {
        let _ = fs::remove_file(tmp);
        return Err(error);
    }
    Ok(())
}

/// 正在进行的下载，按前端给的 id 存一个取消标记。
///
/// 流式读的循环每 250 ms 看一次这个标记，看到就杀掉 gh、删掉临时文件。
#[derive(Default)]
pub struct DownloadState {
    inner: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl DownloadState {
    pub fn start(&self, id: &str) -> Arc<AtomicBool> {
        let mut guard = self.inner.lock().expect("download state poisoned");
        Arc::clone(
            guard
                .entry(id.to_string())
                .or_insert_with(|| Arc::new(AtomicBool::new(false))),
        )
    }

    pub fn finish(&self, id: &str) {
        self.inner
            .lock()
            .expect("download state poisoned")
            .remove(id);
    }

    pub fn cancel(&self, id: &str) {
        if let Some(flag) = self
            .inner
            .lock()
            .expect("download state poisoned")
            .get(id)
        {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const RELEASES: &str = r#"[
        {"id": 1, "tag_name": "v1.2.0", "name": "Release 1.2.0", "body": "Notes",
         "draft": false, "prerelease": true,
         "created_at": "2026-10-20T12:00:00Z", "published_at": "2026-10-20T12:30:00Z",
         "html_url": "https://github.com/me/app/releases/tag/v1.2.0",
         "assets": [{"id": 10, "name": "app-setup.exe", "size": 5242880, "download_count": 3,
                     "content_type": "application/octet-stream",
                     "updated_at": "2026-10-20T12:31:00Z"}]}
    ]"#;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "verta-releases-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    #[test]
    fn parses_a_release_and_its_assets() {
        let releases = parse_releases(RELEASES, 30).expect("parse");
        assert_eq!(releases.len(), 1);
        let release = &releases[0];
        assert_eq!(release.id, 1);
        assert_eq!(release.tag_name, "v1.2.0");
        assert_eq!(release.name, "Release 1.2.0");
        assert_eq!(release.body, "Notes");
        assert!(!release.draft);
        assert!(release.prerelease);
        assert_eq!(
            release.published_at.as_deref(),
            Some("2026-10-20T12:30:00Z")
        );
        assert_eq!(
            release.html_url,
            "https://github.com/me/app/releases/tag/v1.2.0"
        );
        assert_eq!(release.assets.len(), 1);
        assert_eq!(
            release.assets[0],
            RepoReleaseAsset {
                id: 10,
                name: "app-setup.exe".to_string(),
                size: 5_242_880,
                download_count: 3,
                content_type: Some("application/octet-stream".to_string()),
                updated_at: Some("2026-10-20T12:31:00Z".to_string()),
            }
        );
    }

    #[test]
    fn falls_back_to_the_tag_when_the_name_is_blank() {
        let json = r#"[{"id":1,"tag_name":"v1","name":"  ","body":null}]"#;
        let releases = parse_releases(json, 30).expect("parse");
        assert_eq!(releases[0].name, "v1");
        assert_eq!(releases[0].body, "");
    }

    #[test]
    fn keeps_draft_and_prerelease_markers() {
        let json = r#"[{"id":1,"tag_name":"v1","draft":true,"prerelease":true}]"#;
        let releases = parse_releases(json, 30).expect("parse");
        assert!(releases[0].draft);
        assert!(releases[0].prerelease);
    }

    #[test]
    fn skips_one_broken_release_but_keeps_the_rest() {
        let json = r#"[{"id":1,"name":"no tag"},{"id":2,"tag_name":"v2"}]"#;
        let releases = parse_releases(json, 30).expect("parse");
        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].tag_name, "v2");
    }

    #[test]
    fn fails_when_no_release_could_be_read() {
        let json = r#"[{"id":1,"name":"no tag"}]"#;
        let error = parse_releases(json, 30).expect_err("must fail");
        assert!(error.contains("一条"), "{error}");
    }

    #[test]
    fn fails_on_json_that_is_not_an_array() {
        assert!(parse_releases("{}", 30).is_err());
        assert!(parse_releases("not json", 30).is_err());
    }

    #[test]
    fn an_empty_array_is_a_read_with_no_releases() {
        assert!(parse_releases("[]", 30).expect("parse").is_empty());
    }

    #[test]
    fn drops_an_asset_without_an_id() {
        let json = r#"[{"id":1,"tag_name":"v1","assets":[
            {"name":"no-id"},
            {"id":2,"name":"ok.zip","size":10}
        ]}]"#;
        let releases = parse_releases(json, 30).expect("parse");
        assert_eq!(releases[0].assets.len(), 1);
        assert_eq!(releases[0].assets[0].name, "ok.zip");
    }

    #[test]
    fn caps_at_the_requested_limit() {
        let json = r#"[{"id":1,"tag_name":"v1"},{"id":2,"tag_name":"v2"},{"id":3,"tag_name":"v3"}]"#;
        assert_eq!(parse_releases(json, 2).expect("parse").len(), 2);
    }

    #[test]
    fn accepts_plain_and_unicode_names() {
        assert_eq!(safe_file_name("app-setup.exe").unwrap(), "app-setup.exe");
        assert_eq!(safe_file_name("安装包 1.0.zip").unwrap(), "安装包 1.0.zip");
    }

    #[test]
    fn rejects_anything_with_path_semantics() {
        for name in ["../x", "a/b", "a\\b", "..", ".", "", "   "] {
            assert!(safe_file_name(name).is_err(), "{name:?} should be rejected");
        }
    }

    #[test]
    fn rejects_control_characters() {
        assert!(safe_file_name("a\u{0}b").is_err());
        assert!(safe_file_name("a\nb").is_err());
    }

    #[test]
    fn rejects_names_windows_would_rename() {
        for name in ["name.", "name ", " name"] {
            assert!(safe_file_name(name).is_err(), "{name:?} should be rejected");
        }
    }

    #[test]
    fn rejects_windows_reserved_device_names() {
        for name in ["CON", "con.txt", "NUL", "COM1", "LPT9.tar.gz"] {
            assert!(safe_file_name(name).is_err(), "{name:?} should be rejected");
        }
    }

    #[test]
    fn rejects_names_too_long_to_leave_room_for_the_suffix() {
        let long = "a".repeat(181);
        assert!(safe_file_name(&long).is_err());
        let ok = "a".repeat(180);
        assert!(safe_file_name(&ok).is_ok());
    }

    #[test]
    fn reports_when_enough_bytes_arrived() {
        assert!(should_report(0, REPORT_BYTES, Duration::ZERO));
    }

    #[test]
    fn reports_when_enough_time_passed_even_for_a_small_tick() {
        assert!(should_report(0, 1, REPORT_INTERVAL));
    }

    #[test]
    fn stays_quiet_between_small_fast_ticks() {
        assert!(!should_report(
            0,
            1,
            Duration::from_millis(50)
        ));
    }

    #[test]
    fn success_replaces_the_existing_file() {
        let dir = temp_dir("replace");
        let dest = dir.join("app.zip");
        let tmp = dir.join("app.zip.verta-part");
        fs::write(&dest, b"old").expect("write old");
        fs::write(&tmp, b"new").expect("write tmp");
        finish_download(&tmp, &dest, true).expect("finish");
        assert_eq!(fs::read(&dest).unwrap(), b"new");
        assert!(!tmp.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn failure_removes_only_the_temporary_file() {
        let dir = temp_dir("failure");
        let dest = dir.join("app.zip");
        let tmp = dir.join("app.zip.verta-part");
        fs::write(&dest, b"old").expect("write old");
        fs::write(&tmp, b"partial").expect("write tmp");
        finish_download(&tmp, &dest, false).expect("finish");
        assert_eq!(fs::read(&dest).unwrap(), b"old");
        assert!(!tmp.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancel_flips_the_flag_of_a_running_download() {
        let state = DownloadState::default();
        let flag = state.start("dl-1");
        assert!(!flag.load(Ordering::SeqCst));
        state.cancel("dl-1");
        assert!(flag.load(Ordering::SeqCst));
    }

    #[test]
    fn cancelling_an_unknown_download_is_harmless() {
        let state = DownloadState::default();
        state.cancel("nope");
    }

    #[test]
    fn finishing_forgets_the_flag_so_a_late_cancel_does_nothing() {
        let state = DownloadState::default();
        let flag = state.start("dl-1");
        state.finish("dl-1");
        state.cancel("dl-1");
        assert!(!flag.load(Ordering::SeqCst));
    }
}
