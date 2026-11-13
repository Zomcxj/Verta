//! Claude Code's sessions: one transcript per session, under a directory per project.
//!
//! `~/.claude/projects/<cwd with punctuation flattened>/<session-id>.jsonl`, and beside each
//! transcript a *directory* of the same name holding that session's subagent transcripts. Only the
//! top-level `.jsonl` files are sessions: an `agent-*.jsonl` under that directory is one subagent's
//! turns, and listing those would show a session per helper a session started.
//!
//! The transcript is Claude Code's own ledger and it is mostly bookkeeping - measured on a real one:
//! `mode`, `permission-mode`, `atis-latch`, `api-request`, `api-request-blob`, `cost-state`,
//! `file-history-snapshot`, `agent-color`, `attachment`, ... What a list row needs is in three of the
//! kinds (`system` for the id and cwd, `user`/`assistant` for the conversation, `custom-title` /
//! `agent-name` for the name), so everything is selected by kind and nothing is assumed about the
//! rest. There is no `summary` kind, and a `last-prompt` line carries the last prompt written.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::stats::{self, iso_ms, SessionStats};
use super::types::{AgentSession, AgentSessionsPayload};

pub(crate) const TOOL: &str = "claude";

const MAX_TITLE_CHARS: usize = 80;
/// How much of a transcript is read for the header, the name and the first prompt. Those lines are
/// within the first handful of events on the transcripts measured here (2.4 MB, 777+ events), and a
/// transcript is never read whole for a list.
const MAX_PREFIX_LINES: usize = 100_000;
const MAX_PREFIX_BYTES: u64 = 1024 * 1024;

pub(crate) fn default_root() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".claude/projects"))
}

pub(crate) fn list() -> Result<AgentSessionsPayload, String> {
    let root = default_root().ok_or("找不到用户主目录，无法定位 Claude Code 会话目录")?;
    list_at(&root)
}

pub(crate) fn list_at(root: &Path) -> Result<AgentSessionsPayload, String> {
    if !root.is_dir() {
        return Err(format!(
            "找不到 Claude Code 会话目录：{}。请确认 Claude Code 已安装并至少运行过一次。",
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

/// The transcripts directly in one project directory, and nothing deeper.
fn session_files(project_dir: &Path) -> Vec<PathBuf> {
    child_paths(project_dir)
        .unwrap_or_default()
        .into_iter()
        .filter(|child| child.is_file())
        .filter(|file| file.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
        .collect()
}

fn child_paths(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("无法读取目录 {}：{e}", dir.display()))?;
    Ok(entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .collect())
}

/// `Ok(None)` marks a file that cannot be a session: no id anywhere, not even in its name.
fn read_session(file: &Path) -> Result<Option<AgentSession>, String> {
    let prefix = read_prefix(file)?;
    // A `.jsonl` with not one parseable event in it is not a session that lost its cwd: it is junk, or
    // a file this version of the tool does not write. Skipped silently, so the list is shorter rather
    // than noisy.
    if !prefix.lines().any(|line| parse_line(line).is_some()) {
        return Ok(None);
    }
    // Claude Code names the file after the session id, and the id is also on most events; the file
    // name is the one that is there whatever the version writes.
    let id = session_id(&prefix).or_else(|| {
        file.file_stem()
            .and_then(|stem| stem.to_str())
            .map(str::to_string)
    });
    let Some(id) = id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let Some(cwd) = first_string(&prefix, "cwd") else {
        // Every event of a real transcript carries the cwd (`system`, `user` and `assistant` alike).
        // Without it a row could not say where the session ran, and the directory name cannot be
        // un-flattened back into a path: `C--Users-cxj-Desktop` has lost which separators were there.
        return Err(format!("会话 {} 里没有任何一行记录 cwd", file.display()));
    };
    let title = title_of(&prefix)
        .or_else(|| last_prompt(&prefix))
        .unwrap_or_else(|| id.clone());
    Ok(Some(AgentSession {
        tool: TOOL.to_string(),
        id,
        title,
        cwd,
        updated_at_ms: modified_ms(file).unwrap_or(0),
        // Claude Code has no session-of-a-session: a subagent's turns are in the directory beside the
        // transcript, and those are not sessions (see `session_files`).
        parent_id: None,
        stats: session_stats(file),
    }))
}

/// The session id as the transcript records it.
fn session_id(prefix: &str) -> Option<String> {
    first_string(prefix, "sessionId")
}

/// The first value of `key` that any line carries as a string.
fn first_string(prefix: &str, key: &str) -> Option<String> {
    prefix
        .lines()
        .filter_map(parse_line)
        .find_map(|value| value.get(key).and_then(Value::as_str).map(str::to_string))
}

/// The name the session is filed under, in the order the tools that write it take precedence.
///
/// A name the user set wins over anything derived from the conversation, and the first name written
/// wins over later ones so the list does not change when a session is continued.
fn title_of(prefix: &str) -> Option<String> {
    let mut first_human: Option<String> = None;
    for value in prefix.lines().filter_map(parse_line) {
        match value.get("type").and_then(Value::as_str) {
            Some("custom-title") => {
                if let Some(name) = named(value.get("customTitle")) {
                    return Some(name);
                }
            }
            Some("agent-name") => {
                if let Some(name) = named(value.get("agentName")) {
                    return Some(name);
                }
            }
            Some("user") if first_human.is_none() => {
                first_human = human_text(&value);
            }
            _ => {}
        }
    }
    first_human
}

/// The last prompt the transcript recorded, as a name of last resort.
fn last_prompt(prefix: &str) -> Option<String> {
    prefix
        .lines()
        .filter_map(parse_line)
        .filter(|value| value.get("type").and_then(Value::as_str) == Some("last-prompt"))
        .filter_map(|value| named(value.get("lastPrompt")))
        .next_back()
}

fn named(value: Option<&Value>) -> Option<String> {
    let text = collapse_whitespace(value?.as_str()?);
    if text.is_empty() {
        return None;
    }
    Some(truncate_chars(&text, MAX_TITLE_CHARS))
}

/// Whether a line is a person writing, and what they wrote.
///
/// Three kinds of `user` line are not the person: a sidechain (a subagent's prompt), a meta line, and
/// the machine's own markers - measured on real transcripts, the first `user` line of a session is
/// `<system-reminder>…The user named this session "daily task"…`, and a session that only ran one
/// command has `<command-name>/exit</command-name>` and `<local-command-stdout>`. Those all start
/// with `<`, which is what distinguishes them from something a person typed.
fn human_text(value: &Value) -> Option<String> {
    if value.get("isMeta").and_then(Value::as_bool) == Some(true)
        || value.get("isSidechain").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    let message = value.get("message")?;
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let text = collapse_whitespace(&text_of_content(message.get("content")?)?);
    if text.is_empty() || text.starts_with('<') {
        return None;
    }
    Some(truncate_chars(&text, MAX_TITLE_CHARS))
}

/// The text of a message content, which is a string or a list of parts.
fn text_of_content(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => {
            let text = parts
                .iter()
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(" ");
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn session_stats(file: &Path) -> SessionStats {
    let Ok(handle) = std::fs::File::open(file) else {
        return SessionStats::default();
    };
    let mut turns = 0u32;
    let mut token_parts: Vec<u64> = Vec::new();
    let mut last_message_ms: Option<i64> = None;
    let mut reader = BufReader::new(handle);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let Some(value) = parse_line(line.trim_end()) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("user") => {
                if human_text(&value).is_some() {
                    turns = turns.saturating_add(1);
                }
                if let Some(ms) = stamp_of(&value) {
                    last_message_ms = Some(last_message_ms.map_or(ms, |kept: i64| kept.max(ms)));
                }
            }
            Some("assistant") => {
                if let Some(ms) = stamp_of(&value) {
                    last_message_ms = Some(last_message_ms.map_or(ms, |kept: i64| kept.max(ms)));
                }
                if let Some(tokens) = stats::claude_tokens_of_message(&value) {
                    token_parts.push(tokens);
                }
            }
            _ => {}
        }
    }
    SessionStats {
        turns: Some(turns),
        tokens: stats::sum_tokens(token_parts),
        last_at_ms: last_message_ms,
    }
}

/// When a line happened. The transcript writes ISO-8601 UTC on its conversation events.
fn stamp_of(value: &Value) -> Option<i64> {
    value.get("timestamp").and_then(Value::as_str).and_then(iso_ms)
}

fn parse_line(line: &str) -> Option<Value> {
    serde_json::from_str::<Value>(line).ok()
}

fn read_prefix(file: &Path) -> Result<String, String> {
    let handle = std::fs::File::open(file)
        .map_err(|e| format!("无法打开会话文件 {}：{e}", file.display()))?;
    let mut reader = BufReader::new(handle.take(MAX_PREFIX_BYTES));
    let mut prefix = String::new();
    let mut line = String::new();
    let mut lines = 0;
    while lines < MAX_PREFIX_LINES {
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

/// A session's transcript and the directory of subagent transcripts beside it.
struct Located {
    file: PathBuf,
    owned_directory: Option<PathBuf>,
}

/// Where a session's own files are, by the name Claude Code files it under.
fn locate(root: &Path, id: &str) -> Result<Located, String> {
    if id.is_empty() || id.contains(['/', '\\']) {
        // The id comes from the page and is about to be a path component.
        return Err(format!("非法的会话 id：{id}"));
    }
    for project_dir in child_paths(root)? {
        if !project_dir.is_dir() {
            continue;
        }
        for file in session_files(&project_dir) {
            if file.file_stem().and_then(|stem| stem.to_str()) != Some(id) {
                continue;
            }
            let candidate = file.with_extension("");
            return Ok(Located {
                file,
                owned_directory: candidate.is_dir().then_some(candidate),
            });
        }
    }
    Err(format!("Claude Code 里找不到会话 {id}"))
}

pub(crate) fn delete_at(root: &Path, id: &str) -> Result<(), String> {
    if !root.is_dir() {
        return Err(format!(
            "找不到 Claude Code 会话目录：{}。请确认 Claude Code 已安装并至少运行过一次。",
            root.display()
        ));
    }
    let located = locate(root, id)?;
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|e| format!("无法解析 Claude Code 会话目录 {}：{e}", root.display()))?;
    let mut targets = vec![located.file];
    if let Some(directory) = located.owned_directory {
        targets.push(directory);
    }
    // Every removal is proved to sit inside the root before anything is removed.
    for target in &targets {
        let canonical = std::fs::canonicalize(target)
            .map_err(|e| format!("无法解析待删除路径 {}：{e}", target.display()))?;
        if !canonical.starts_with(&canonical_root) {
            return Err(format!(
                "拒绝删除 Claude Code 会话目录之外的路径：{}",
                canonical.display()
            ));
        }
    }
    for target in targets {
        let removed = if target.is_dir() {
            std::fs::remove_dir_all(&target)
        } else {
            std::fs::remove_file(&target)
        };
        removed.map_err(|e| format!("删除 {} 失败：{e}", target.display()))?;
    }
    Ok(())
}

pub(crate) fn exists_at(root: &Path, id: &str) -> Result<bool, String> {
    Ok(locate(root, id).is_ok())
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

    /// A transcript with the shapes a real one has: bookkeeping first, then the events that matter.
    fn write_session(dir: &Path, id: &str, extra: &str) -> PathBuf {
        let body = format!(
            concat!(
                "{{\"type\":\"mode\",\"sessionId\":\"{id}\"}}\n",
                "{{\"type\":\"system\",\"subtype\":\"init\",\"sessionId\":\"{id}\",",
                "\"cwd\":\"C:\\\\Users\\\\cxj\\\\Desktop\\\\dsh\",",
                "\"timestamp\":\"2026-11-13T01:05:59.276Z\",\"uuid\":\"u1\"}}\n",
                "{{\"type\":\"custom-title\",\"customTitle\":\"daily task\",\"sessionId\":\"{id}\"}}\n",
                "{{\"type\":\"user\",\"sessionId\":\"{id}\",\"cwd\":\"C:\\\\Users\\\\cxj\\\\Desktop\\\\dsh\",",
                "\"isMeta\":true,\"timestamp\":\"2026-11-13T01:06:00.000Z\",",
                "\"message\":{{\"role\":\"user\",\"content\":\"<system-reminder>ignore me</system-reminder>\"}}}}\n",
                "{{\"type\":\"user\",\"sessionId\":\"{id}\",\"cwd\":\"C:\\\\Users\\\\cxj\\\\Desktop\\\\dsh\",",
                "\"timestamp\":\"2026-11-13T01:06:03.000Z\",",
                "\"message\":{{\"role\":\"user\",\"content\":\"对E:\\\\GitPro 中项目分析分类打分\"}}}}\n",
                "{{\"type\":\"assistant\",\"sessionId\":\"{id}\",\"cwd\":\"C:\\\\Users\\\\cxj\\\\Desktop\\\\dsh\",",
                "\"timestamp\":\"2026-11-13T01:06:20.000Z\",",
                "\"message\":{{\"role\":\"assistant\",\"usage\":{{\"input_tokens\":100,",
                "\"output_tokens\":7,\"cache_read_input_tokens\":3,\"cache_creation_input_tokens\":1}}}}}}\n",
                "{extra}"
            ),
            id = id,
            extra = extra
        );
        write_file(dir, &format!("{id}.jsonl"), &body)
    }

    fn cwd() -> String {
        "C:\\Users\\cxj\\Desktop\\dsh".to_string()
    }

    #[test]
    fn lists_a_project_directory_with_its_name_cwd_and_numbers() {
        let dir = tempfile::tempdir().expect("temp dir");
        let project = dir.path().join("C--Users-cxj-Desktop-dsh");
        write_session(&project, "13288075-8901-4ca0-812e-de1b766f4ad8", "");
        let payload = list_at(dir.path()).expect("应能列出");
        assert_eq!(payload.warnings, Vec::<String>::new());
        assert_eq!(payload.sessions.len(), 1);
        let session = &payload.sessions[0];
        assert_eq!(session.tool, "claude");
        assert_eq!(session.id, "13288075-8901-4ca0-812e-de1b766f4ad8");
        assert_eq!(session.title, "daily task", "名字优先于对话");
        assert_eq!(session.cwd, cwd());
        assert_eq!(session.parent_id, None);
        // One person wrote one thing; the meta line and the bookkeeping are not turns.
        assert_eq!(session.stats.turns, Some(1));
        assert_eq!(session.stats.tokens, Some(111));
        assert_eq!(
            session.stats.last_at_ms,
            iso_ms("2026-11-13T01:06:20.000Z"),
            "最后对话时间取对话事件里最晚的一条"
        );
    }

    #[test]
    fn takes_the_first_human_line_when_no_name_was_set() {
        let dir = tempfile::tempdir().expect("temp dir");
        let project = dir.path().join("C--Users-cxj-Desktop-dsh");
        let path = write_session(&project, "s1", "");
        // Drop the name line, as a session that was never named has none.
        let body = std::fs::read_to_string(&path)
            .expect("read")
            .lines()
            .filter(|line| !line.contains("custom-title"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&path, body).expect("write");
        let payload = list_at(dir.path()).expect("应能列出");
        assert_eq!(
            payload.sessions[0].title,
            "对E:\\GitPro 中项目分析分类打分",
            "第一条人话就是名字，<system-reminder> 那条不算"
        );
    }

    #[test]
    fn falls_back_to_the_last_prompt_then_to_the_id() {
        let dir = tempfile::tempdir().expect("temp dir");
        let project = dir.path().join("C--Users-cxj-Desktop-dsh");
        // A session that only ran a command: no name, and nobody spoke.
        write_file(
            &project,
            "only-commands.jsonl",
            concat!(
                "{\"type\":\"system\",\"sessionId\":\"only-commands\",\"cwd\":\"C:\\\\Users\\\\cxj\",",
                "\"timestamp\":\"2026-11-13T01:05:59.276Z\"}\n",
                "{\"type\":\"user\",\"sessionId\":\"only-commands\",\"cwd\":\"C:\\\\Users\\\\cxj\",",
                "\"timestamp\":\"2026-11-13T01:06:03.456Z\",",
                "\"message\":{\"role\":\"user\",\"content\":\"<command-name>/exit</command-name>\"}}\n",
                "{\"type\":\"last-prompt\",\"lastPrompt\":\"看看这个仓库\",\"sessionId\":\"only-commands\"}\n"
            ),
        );
        let payload = list_at(dir.path()).expect("列");
        assert_eq!(payload.sessions.len(), 1);
        assert_eq!(
            payload.sessions[0].title, "看看这个仓库",
            "只有机器标记时，最后一条 prompt 就是能拿到的最好名字"
        );
        assert_eq!(payload.sessions[0].stats.turns, Some(0), "跑命令不是用户开的一轮");

        // And with nothing at all to name it, the id is the last resort - never an empty row.
        let dir2 = tempfile::tempdir().expect("temp dir");
        write_file(
            &dir2.path().join("C--Users-cxj-Desktop-dsh"),
            "s1.jsonl",
            "{\"type\":\"system\",\"sessionId\":\"s1\",\"cwd\":\"C:\\\\Users\\\\cxj\",\"timestamp\":\"2026-11-13T01:05:59.276Z\"}\n",
        );
        assert_eq!(list_at(dir2.path()).expect("列").sessions[0].title, "s1");
    }

    #[test]
    fn does_not_list_the_subagents_beside_a_session() {
        let dir = tempfile::tempdir().expect("temp dir");
        let project = dir.path().join("C--Users-cxj-Desktop-dsh");
        write_session(&project, "s1", "");
        // A subagent's own transcript, one level down, exactly where Claude Code keeps them.
        write_file(
            &project.join("s1/subagents/workflows/run-1"),
            "agent-abc.jsonl",
            "{\"type\":\"user\",\"sessionId\":\"s1\",\"cwd\":\"C:\\\\x\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
        );
        let payload = list_at(dir.path()).expect("应能列出");
        assert_eq!(payload.sessions.len(), 1, "只列顶层转录");
        assert_eq!(payload.sessions[0].id, "s1");
    }

    #[test]
    fn a_broken_file_warns_and_does_not_take_the_tree_with_it() {
        let dir = tempfile::tempdir().expect("temp dir");
        let project = dir.path().join("C--Users-cxj-Desktop-dsh");
        write_session(&project, "good", "");
        // A transcript with no cwd anywhere: it cannot be placed, and it is said so rather than
        // guessed from the flattened directory name.
        write_file(&project, "bad.jsonl", "{\"type\":\"mode\",\"sessionId\":\"bad\"}\n");
        // And one that is not JSON at all.
        write_file(&project, "junk.jsonl", "not json at all\n");
        let payload = list_at(dir.path()).expect("应能列出");
        assert_eq!(payload.sessions.len(), 1);
        assert_eq!(payload.sessions[0].id, "good");
        assert_eq!(payload.warnings.len(), 1, "坏行只警告，不整棵树失败");
        assert!(payload.warnings[0].contains("bad.jsonl"));
    }

    #[test]
    fn the_id_comes_from_the_file_name_when_the_transcript_never_says_it() {
        let dir = tempfile::tempdir().expect("temp dir");
        let project = dir.path().join("C--Users-cxj-Desktop-dsh");
        write_file(
            &project,
            "9f1c2d3e-0000-4000-8000-000000000000.jsonl",
            "{\"type\":\"system\",\"cwd\":\"C:\\\\x\",\"timestamp\":\"2026-11-13T01:05:59.276Z\"}\n",
        );
        let payload = list_at(dir.path()).expect("应能列出");
        assert_eq!(payload.sessions[0].id, "9f1c2d3e-0000-4000-8000-000000000000");
    }

    #[test]
    fn deleting_takes_the_transcript_and_the_subagent_directory_beside_it() {
        let dir = tempfile::tempdir().expect("temp dir");
        let project = dir.path().join("C--Users-cxj-Desktop-dsh");
        let path = write_session(&project, "s1", "");
        let subagents = project.join("s1/subagents");
        write_file(&subagents, "agent-abc.jsonl", "{}\n");
        assert!(exists_at(dir.path(), "s1").expect("存在"));
        delete_at(dir.path(), "s1").expect("应能删除");
        assert!(!path.exists(), "转录删掉了");
        assert!(!project.join("s1").exists(), "子代理目录一起删掉了");
        assert!(!exists_at(dir.path(), "s1").expect("查询"));
        // Another session in the same project is untouched.
        write_session(&project, "s2", "");
        delete_at(dir.path(), "s1").expect_err("再删一次要说找不到");
        assert!(exists_at(dir.path(), "s2").expect("查询"));
    }

    #[test]
    fn refuses_an_id_that_could_escape_the_root() {
        let dir = tempfile::tempdir().expect("temp dir");
        let project = dir.path().join("C--Users-cxj-Desktop-dsh");
        write_session(&project, "s1", "");
        for id in ["", "..", "../s1", "a/b", "a\\b"] {
            assert!(delete_at(dir.path(), id).is_err(), "{id} 不该被接受");
            assert!(exists_at(dir.path(), id).is_ok_and(|found| !found), "{id}");
        }
        assert!(delete_at(dir.path(), "nope").is_err(), "不存在的 id 要报错");
    }

    #[test]
    fn a_missing_root_says_so_instead_of_listing_nothing() {
        let dir = tempfile::tempdir().expect("temp dir");
        let missing = dir.path().join("nope");
        let error = list_at(&missing).expect_err("目录不在要报错");
        assert!(error.contains("Claude Code"), "错误要说清是哪个工具：{error}");
    }
}
