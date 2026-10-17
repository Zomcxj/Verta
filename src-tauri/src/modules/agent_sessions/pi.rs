use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::types::{AgentSession, AgentSessionsPayload};

pub(crate) const TOOL: &str = "pi";

const MAX_TITLE_CHARS: usize = 80;
/// The name is written wherever the user names the session, which on this
/// machine happened 3.98 MiB into a 4.18 MiB file, so the window has to be
/// large. The scan stops at the first name, which keeps the common case
/// (named near the top) cheap; a session renamed again later keeps its earlier
/// name. Measured: first user messages sit within 77 KiB.
const MAX_PREFIX_LINES: usize = 100_000;
const MAX_PREFIX_BYTES: u64 = 8 * 1024 * 1024;

pub(crate) fn default_root() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".pi/agent/sessions"))
}

pub(crate) fn list() -> Result<AgentSessionsPayload, String> {
    let root = default_root().ok_or("找不到用户主目录，无法定位 pi 会话目录")?;
    list_at(&root)
}

pub(crate) fn list_at(root: &Path) -> Result<AgentSessionsPayload, String> {
    if !root.is_dir() {
        return Err(format!(
            "找不到 pi 会话目录：{}。请确认 pi 已安装并至少运行过一次。",
            root.display()
        ));
    }
    let mut sessions = Vec::new();
    let mut warnings = Vec::new();
    for project_dir in child_paths(root)? {
        if !project_dir.is_dir() {
            continue;
        }
        for file in session_files(&project_dir) {
            match read_session(&file) {
                Ok(Some(session)) => sessions.push(session),
                Ok(None) => {}
                Err(error) => warnings.push(error),
            }
        }
    }
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at_ms));
    Ok(AgentSessionsPayload { sessions, warnings })
}

/// The session files of one project directory: its own transcripts, plus the
/// forks of each session. pi writes a fork under `<stem>/forks` next to that
/// session's run artifacts (`<stem>/<run uuid>/run-0`), so a fork sits one
/// level deeper than the transcript it branched from; nothing deeper than
/// `forks` is a session.
fn session_files(project_dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for child in child_paths(project_dir).unwrap_or_default() {
        if child.is_dir() {
            files.extend(child_paths(&child.join("forks")).unwrap_or_default());
        } else {
            files.push(child);
        }
    }
    files.retain(|file| file.extension().and_then(|ext| ext.to_str()) == Some("jsonl"));
    files
}

fn child_paths(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("无法读取目录 {}：{e}", dir.display()))?;
    Ok(entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .collect())
}

/// `Ok(None)` marks a file that is not a session (a run artifact, an empty file).
fn read_session(file: &Path) -> Result<Option<AgentSession>, String> {
    let prefix = read_prefix(file)?;
    let Some(header) = prefix.lines().next().and_then(parse_line) else {
        return Ok(None);
    };
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return Ok(None);
    }
    let Some(id) = header.get("id").and_then(Value::as_str) else {
        return Ok(None);
    };
    let cwd = header
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            file.parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                .and_then(decode_cwd_dirname)
        });
    let Some(cwd) = cwd else {
        return Err(format!("会话 {} 既没有 cwd 也无法从目录名还原", file.display()));
    };
    let title = title_from_prefix(&prefix).unwrap_or_else(|| {
        file.file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or(id)
            .to_string()
    });
    Ok(Some(AgentSession {
        tool: TOOL.to_string(),
        id: id.to_string(),
        title,
        cwd,
        updated_at_ms: modified_ms(file).unwrap_or(0),
        parent_id: header
            .get("parentSession")
            .and_then(Value::as_str)
            .map(str::to_string),
    }))
}

fn parse_line(line: &str) -> Option<Value> {
    serde_json::from_str::<Value>(line).ok()
}

/// Title priority: the name the user gave the session, then the first user
/// message. The name is written mid-file, so both are collected in one pass.
pub(crate) fn title_from_prefix(prefix: &str) -> Option<String> {
    let mut first_user: Option<String> = None;
    for value in prefix.lines().filter_map(parse_line) {
        match value.get("type").and_then(Value::as_str) {
            Some("session_info") => {
                let name = value
                    .get("name")
                    .and_then(Value::as_str)
                    .map(collapse_whitespace)
                    .filter(|name| !name.is_empty());
                if let Some(name) = name {
                    return Some(name);
                }
            }
            Some("message") if first_user.is_none() => {
                let message = value.get("message");
                if message.and_then(|m| m.get("role")).and_then(Value::as_str) == Some("user") {
                    first_user = message
                        .and_then(|m| m.get("content"))
                        .and_then(text_of_content);
                }
            }
            _ => {}
        }
    }
    first_user
}

fn text_of_content(content: &Value) -> Option<String> {
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => return None,
    };
    let text = collapse_whitespace(&text);
    if text.is_empty() {
        return None;
    }
    Some(truncate_chars(&text, MAX_TITLE_CHARS))
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut truncated: String = text.chars().take(max).collect();
    truncated.push('…');
    truncated
}

/// Fallback for a header without `cwd`. The encoding flattens path separators
/// to `-`, so a directory name that itself contains `-` decodes to the wrong
/// path; only used when the first line is unreadable.
pub(crate) fn decode_cwd_dirname(name: &str) -> Option<String> {
    let inner = name.strip_prefix("--")?.strip_suffix("--")?;
    let (drive, rest) = inner.split_once("--")?;
    if drive.is_empty() {
        return None;
    }
    Some(format!("{}:\\{}", drive, rest.replace('-', "\\")))
}

fn read_prefix(file: &Path) -> Result<String, String> {
    read_prefix_with(file, MAX_PREFIX_BYTES, MAX_PREFIX_LINES)
}

/// Split out so the two bounds can be exercised without writing megabytes.
fn read_prefix_with(file: &Path, max_bytes: u64, max_lines: usize) -> Result<String, String> {
    let handle = std::fs::File::open(file)
        .map_err(|e| format!("无法打开会话文件 {}：{e}", file.display()))?;
    let mut reader = BufReader::new(handle.take(max_bytes));
    let mut prefix = String::new();
    let mut line = String::new();
    let mut lines = 0;
    while lines < max_lines {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                prefix.push_str(&line);
                lines += 1;
            }
            // The byte cap can cut a multi-byte character; keep what was read.
            Err(error) if error.kind() == std::io::ErrorKind::InvalidData => break,
            Err(error) => return Err(format!("读取会话文件 {} 失败：{error}", file.display())),
        }
    }
    Ok(prefix)
}

fn modified_ms(file: &Path) -> Option<i64> {
    let modified = std::fs::metadata(file).ok()?.modified().ok()?;
    let since_epoch = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(since_epoch.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_file(dir: &Path, name: &str, body: &str) -> PathBuf {
        std::fs::create_dir_all(dir).expect("create dir");
        let path = dir.join(name);
        std::fs::write(&path, body).expect("write");
        path
    }

    #[test]
    fn prefers_the_session_info_name() {
        let prefix = concat!(
            r#"{"type":"session","version":3,"id":"01a147ad","timestamp":"2026-10-17T02:24:43.071Z","cwd":"F:\\VibeCoding_workspace\\WorkBuddy"}"#,
            "\n",
            r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"随便问问"}]}}"#,
            "\n",
            r#"{"type":"session_info","id":"d7c7f713","timestamp":"2026-10-17T02:25:47.637Z","name":"daily talk"}"#,
            "\n",
        );
        assert_eq!(title_from_prefix(prefix).as_deref(), Some("daily talk"));
    }

    #[test]
    fn falls_back_to_the_first_user_message() {
        let prefix = concat!(
            r#"{"type":"session","version":3,"id":"01a0fa77","cwd":"F:\\x"}"#,
            "\n",
            r#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"我是助手"}]}}"#,
            "\n",
            r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"查看pi是否有两个压缩插件一个自带一个第三方"}]}}"#,
            "\n",
        );
        assert_eq!(
            title_from_prefix(prefix).as_deref(),
            Some("查看pi是否有两个压缩插件一个自带一个第三方")
        );
    }

    #[test]
    fn accepts_string_content_and_collapses_whitespace() {
        // Raw string keeps `\n` a JSON escape: a JSONL line can never contain a
        // literal newline, so the whitespace to collapse must arrive encoded.
        let prefix = r#"{"type":"message","message":{"role":"user","content":"  多行\n  内容  "}}"#;
        assert_eq!(title_from_prefix(prefix).as_deref(), Some("多行 内容"));
    }

    #[test]
    fn a_literal_newline_inside_a_json_string_is_not_a_session_line() {
        // Guards the JSONL assumption above: such a line is invalid JSON and is
        // skipped rather than half-parsed.
        let prefix = "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"a\nb\"}}";
        assert_eq!(title_from_prefix(prefix), None);
    }

    #[test]
    fn ignores_broken_lines_and_returns_none_without_any_signal() {
        assert_eq!(
            title_from_prefix("{not json}\n{\"type\":\"model_change\"}"),
            None
        );
    }

    #[test]
    fn truncates_a_long_title_on_a_character_boundary() {
        let long = "好".repeat(200);
        let prefix = format!(
            "{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"{long}\"}}}}"
        );
        let title = title_from_prefix(&prefix).expect("title");
        assert_eq!(title.chars().count(), MAX_TITLE_CHARS + 1);
        assert!(title.ends_with('…'));
    }

    #[test]
    fn the_prefix_window_is_bounded_by_bytes_and_lines() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = write_file(dir.path(), "s.jsonl", "aaaa\nbbbb\ncccc\n");
        assert_eq!(
            read_prefix_with(&path, 10, 100).expect("prefix"),
            "aaaa\nbbbb\n"
        );
        assert_eq!(read_prefix_with(&path, 4096, 1).expect("prefix"), "aaaa\n");
    }

    #[test]
    fn a_name_far_past_the_first_message_still_wins() {
        // Locks why the window is megabytes wide: pi writes the name when the
        // user names the session, which can be far past the opening exchange.
        let dir = tempfile::tempdir().expect("temp dir");
        let body = format!(
            "{}\n{}\n{}\n{}\n",
            r#"{"type":"session","id":"s1","cwd":"F:\\x"}"#,
            r#"{"type":"message","message":{"role":"user","content":"第一句"}}"#,
            "x".repeat(64),
            r#"{"type":"session_info","name":"晚来的名字"}"#,
        );
        let path = write_file(dir.path(), "s.jsonl", &body);
        let prefix = read_prefix_with(&path, 4096, 100).expect("prefix");
        assert_eq!(title_from_prefix(&prefix).as_deref(), Some("晚来的名字"));
    }

    #[test]
    fn decodes_the_two_real_directory_shapes() {
        assert_eq!(
            decode_cwd_dirname("--F--VibeCoding_workspace-ModelHarbor--").as_deref(),
            Some("F:\\VibeCoding_workspace\\ModelHarbor")
        );
        assert_eq!(
            decode_cwd_dirname("--C--Users-费马大定理--").as_deref(),
            Some("C:\\Users\\费马大定理")
        );
        assert_eq!(decode_cwd_dirname("garbage"), None);
    }

    #[test]
    fn scans_top_level_and_forks_but_skips_non_sessions() {
        let root = tempfile::tempdir().expect("temp dir");
        let project = root.path().join("--F--VibeCoding_workspace-ModelHarbor--");
        write_file(
            &project,
            "2026-10-17T02-24-43-071Z_01a147ad.jsonl",
            concat!(
                r#"{"type":"session","version":3,"id":"01a147ad","cwd":"F:\\VibeCoding_workspace\\ModelHarbor"}"#,
                "\n",
                r#"{"type":"session_info","name":"daily talk"}"#,
                "\n",
            ),
        );
        // A fork is kept next to the artifacts of the session it branched from.
        write_file(
            &project.join("2026-10-17T02-24-43-071Z_01a147ad/forks"),
            "2026-10-17T03-00-00-000Z_01a19999.jsonl",
            concat!(
                r#"{"type":"session","version":3,"id":"01a19999","cwd":"F:\\VibeCoding_workspace\\ModelHarbor","parentSession":"01a147ad"}"#,
                "\n",
            ),
        );
        write_file(
            &project.join("subagent-artifacts"),
            "run-0.jsonl",
            "{\"type\":\"artifact\"}\n",
        );

        let payload = list_at(root.path()).expect("list");
        assert_eq!(payload.sessions.len(), 2, "{:?}", payload.sessions);
        assert!(payload.warnings.is_empty(), "{:?}", payload.warnings);
        let fork = payload
            .sessions
            .iter()
            .find(|session| session.id == "01a19999")
            .expect("fork");
        assert_eq!(fork.parent_id.as_deref(), Some("01a147ad"));
        let parent = payload
            .sessions
            .iter()
            .find(|session| session.id == "01a147ad")
            .expect("parent");
        assert_eq!(parent.title, "daily talk");
    }

    #[test]
    fn a_fork_still_lists_when_its_parent_file_is_gone() {
        // This machine has exactly one of these: the parent transcript is gone
        // but the artifact directory, and the forks inside it, stayed.
        let root = tempfile::tempdir().expect("temp dir");
        let project = root.path().join("--F--VibeCoding_workspace-ModelHarbor--");
        write_file(
            &project.join("2026-09-09T10-55-18-316Z_01a085ce/forks"),
            "2026-09-09T13-14-24-105Z_01a0864e.jsonl",
            concat!(
                r#"{"type":"session","version":3,"id":"01a0864e","cwd":"F:\\VibeCoding_workspace\\ModelHarbor","parentSession":"01a085ce"}"#,
                "\n",
            ),
        );
        let payload = list_at(root.path()).expect("list");
        assert_eq!(payload.sessions.len(), 1, "{:?}", payload.sessions);
        assert_eq!(payload.sessions[0].id, "01a0864e");
        assert_eq!(payload.sessions[0].parent_id.as_deref(), Some("01a085ce"));
    }

    #[test]
    fn subagent_run_artifacts_are_not_sessions() {
        let root = tempfile::tempdir().expect("temp dir");
        let project = root.path().join("--F--x--");
        write_file(
            &project,
            "2026-09-12T13-20-04-533Z_01a095c6.jsonl",
            concat!(
                r#"{"type":"session","version":3,"id":"01a095c6","cwd":"F:\\x"}"#,
                "\n",
            ),
        );
        // Real layout: <stem>/<run uuid>/run-0/... holds the subagent output.
        write_file(
            &project.join("2026-09-12T13-20-04-533Z_01a095c6/00e278ab/run-0"),
            "output.jsonl",
            "{\"type\":\"artifact\"}\n",
        );
        let payload = list_at(root.path()).expect("list");
        assert_eq!(payload.sessions.len(), 1, "{:?}", payload.sessions);
        assert!(payload.warnings.is_empty(), "{:?}", payload.warnings);
    }

    #[test]
    fn missing_root_is_a_clear_error_not_an_empty_list() {
        let root = tempfile::tempdir().expect("temp dir");
        let error = list_at(&root.path().join("nope")).expect_err("should fail");
        assert!(error.contains("pi"), "unexpected error: {error}");
    }

    #[test]
    fn a_session_without_cwd_or_decodable_directory_is_reported() {
        let root = tempfile::tempdir().expect("temp dir");
        let project = root.path().join("garbage");
        write_file(
            &project,
            "2026-10-17T02-24-43-071Z_01a147ad.jsonl",
            "{\"type\":\"session\",\"id\":\"x\"}\n",
        );
        let payload = list_at(root.path()).expect("list");
        assert!(payload.sessions.is_empty());
        assert_eq!(payload.warnings.len(), 1);
    }

    #[test]
    fn a_header_without_cwd_uses_the_decoded_directory_name() {
        let root = tempfile::tempdir().expect("temp dir");
        let project = root.path().join("--F--VibeCoding_workspace-portfolio--");
        write_file(
            &project,
            "2026-10-02T02-35-27-525Z_01a0fa77.jsonl",
            "{\"type\":\"session\",\"version\":3,\"id\":\"01a0fa77\"}\n",
        );
        let payload = list_at(root.path()).expect("list");
        assert_eq!(payload.sessions.len(), 1);
        assert_eq!(payload.sessions[0].cwd, "F:\\VibeCoding_workspace\\portfolio");
    }
}