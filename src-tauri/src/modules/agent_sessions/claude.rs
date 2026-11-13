//! Claude Code's sessions: one transcript per session, under a directory per project.
//!
//! `~/.claude/projects/<cwd with punctuation flattened>/<session-id>.jsonl`, and beside each
//! transcript a *directory* of the same name holding the subagents that session started
//! (`subagents/agent-*.jsonl`, a workflow's helpers one level deeper). Those are not sessions of their
//! own - Claude Code has no session-of-a-session - so they are read as what they are: rows carrying
//! their session's id as `parent_id`, with the id off the `agentId` on their own lines and the name off
//! the `.meta.json` beside them. The list the user resumes from hides them (`topLevelSessions`); the
//! manage view shows them, which is the only place a helper run is worth a row.
//!
//! The transcript is Claude Code's own ledger and it is mostly bookkeeping - measured on a real one:
//! `mode`, `permission-mode`, `atis-latch`, `api-request`, `api-request-blob`, `cost-state`,
//! `file-history-snapshot`, `agent-color`, `attachment`, ... What a list row needs is in three of the
//! kinds (`system` for the id and cwd, `user`/`assistant` for the conversation, `custom-title` /
//! `agent-name` for the name), so everything is selected by kind and nothing is assumed about the
//! rest. There is no `summary` kind, and a `last-prompt` line carries the last prompt written.

use std::collections::HashMap;
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
        // Not a failure. A tool that has never run on this machine has nothing to list, and this
        // reader cannot tell that apart from a tool whose store lives somewhere it does not know
        // about - Claude Code honours a configuration directory of its own, and this app reads one
        // fixed path. Saying "not found, check that it is installed" was a claim about the user's
        // machine that this function is in no position to make ("没找到不要说", 2026-11-13). The list
        // answers with its own empty state instead.
        return Ok(AgentSessionsPayload::default());
    }
    let mut sessions = Vec::new();
    let mut warnings = Vec::new();
    for project_dir in child_paths(root)? {
        if !project_dir.is_dir() {
            continue;
        }
        // Sessions first, then the runs they started: a child's `parent_id` has to be the id the parent
        // is *listed* under, and that is what the parent's own transcript says - the directory beside it
        // is normally named after that id, but the listing must not depend on it being so.
        let mut parent_ids: HashMap<String, String> = HashMap::new();
        let mut children: Vec<(PathBuf, String)> = Vec::new();
        for (file, parent) in session_files(&project_dir) {
            let Some(found_under) = parent else {
                match read_session(&file, None) {
                    Ok(Some(session)) => {
                        if let Some(stem) = file.file_stem().and_then(|stem| stem.to_str()) {
                            parent_ids.insert(stem.to_string(), session.id.clone());
                        }
                        sessions.push(session);
                    }
                    Ok(None) => {}
                    Err(error) => warnings.push(error),
                }
                continue;
            };
            children.push((file, found_under));
        }
        for (file, found_under) in children {
            let parent_id = parent_ids.get(&found_under).cloned().unwrap_or(found_under);
            match read_session(&file, Some(&parent_id)) {
                Ok(Some(session)) => sessions.push(session),
                Ok(None) => {}
                Err(error) => warnings.push(error),
            }
        }
    }
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at_ms));
    Ok(AgentSessionsPayload { sessions, warnings })
}

/// A project directory's transcripts, each with the session it belongs to when it is not one itself.
///
/// Claude Code keeps a session's subagents in a directory named after it (`<session-id>/subagents/`),
/// and a workflow's helpers a level deeper still (`subagents/workflows/<id>/`). They are not sessions -
/// the tool has no session-of-a-session - which is why they are not read as ones: the id comes from the
/// file, the name from the `.meta.json` beside it, and the parent from the directory they were found in.
/// They are listed because the manage view exists to show what a session started (`launcher.manage`),
/// and `topLevelSessions` keeps them out of the list the user resumes from.
fn session_files(project_dir: &Path) -> Vec<(PathBuf, Option<String>)> {
    let mut files = Vec::new();
    for child in child_paths(project_dir).unwrap_or_default() {
        if child.is_file() {
            if child.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
                files.push((child, None));
            }
            continue;
        }
        // A directory beside a transcript is that session's own, and everything under it that is an
        // `agent-*.jsonl` is one of the runs it started.
        let Some(stem) = child.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let parent = stem.to_string();
        for file in agent_files(&child) {
            files.push((file, Some(parent.clone())));
        }
    }
    files
}

/// Every `agent-*.jsonl` under one session's directory, at any depth a workflow puts them.
fn agent_files(dir: &Path) -> Vec<PathBuf> {
    // Bounded: a directory tree is not trusted to be finite (nor to be shallow - this one has workflow
    // helpers two levels down).
    const MAX_DEPTH: usize = 5;
    let mut found = Vec::new();
    let mut stack = vec![(dir.to_path_buf(), 0usize)];
    while let Some((next, depth)) = stack.pop() {
        for child in child_paths(&next).unwrap_or_default() {
            if child.is_dir() {
                if depth < MAX_DEPTH {
                    stack.push((child, depth + 1));
                }
                continue;
            }
            let name = child.file_name().and_then(|name| name.to_str());
            if name.is_some_and(|name| name.starts_with("agent-") && name.ends_with(".jsonl")) {
                found.push(child);
            }
        }
    }
    found
}

/// Every usage event in this store, oldest first.
///
/// Unlike the list, which reads a prefix of one transcript per session, this walks every assistant
/// message of every transcript: the day a token was used is the day its message was written, and a
/// session that ran for a week is a week of days. `since_ms` skips what a window's range leaves out;
/// a file that cannot be opened becomes a failure rather than a silent hole in the numbers.
pub(crate) fn usage_events_at(root: &Path, since_ms: Option<i64>) -> super::usage::UsageReadReport {
    let mut report = super::usage::UsageReadReport::default();
    if !root.is_dir() {
        return report;
    }
    let projects = match child_paths(root) {
        Ok(projects) => projects,
        Err(error) => {
            report.failures.push(error);
            return report;
        }
    };
    for project in projects {
        if !project.is_dir() {
            continue;
        }
        let files = match child_paths(&project) {
            Ok(files) => files,
            Err(error) => {
                report.failures.push(error);
                continue;
            }
        };
        for file in files {
            if file.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            collect_usage(&file, since_ms, &mut report);
        }
    }
    report.events.sort_by_key(|event| event.at_ms);
    report
}

/// One transcript's events. A file that cannot be read is reported; a line that is not a usage
/// record is not.
fn collect_usage(file: &Path, since_ms: Option<i64>, report: &mut super::usage::UsageReadReport) {
    let handle = match std::fs::File::open(file) {
        Ok(handle) => handle,
        Err(error) => {
            report
                .failures
                .push(format!("无法打开会话文件 {}：{error}", file.display()));
            return;
        }
    };
    let mut reader = BufReader::new(handle);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) => {
                report.failures.push(format!(
                    "读取会话文件 {} 中断：{error}",
                    file.display()
                ));
                break;
            }
        }
        let Some(value) = parse_line(line.trim_end()) else {
            continue;
        };
        let Some(usage) = super::usage::claude_usage_of_line(&value) else {
            continue;
        };
        // No timestamp, no day to put it in: counted nowhere rather than in the wrong day.
        let Some(at_ms) = stamp_of(&value) else {
            continue;
        };
        if since_ms.is_some_and(|since| at_ms < since) {
            continue;
        }
        report.events.push(super::usage::OwnedUsageEvent {
            at_ms,
            provider: usage.provider,
            model: usage.model,
            tokens: usage.tokens,
        });
    }
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
///
/// `parent` is the session this file was found under, when it is one of its runs rather than a session
/// of its own - which is what a subagent transcript is.
fn read_session(file: &Path, parent: Option<&str>) -> Result<Option<AgentSession>, String> {
    let prefix = read_prefix(file)?;
    // A `.jsonl` with not one parseable event in it is not a session that lost its cwd: it is junk, or
    // a file this version of the tool does not write. Skipped silently, so the list is shorter rather
    // than noisy.
    if !prefix.lines().any(|line| parse_line(line).is_some()) {
        return Ok(None);
    }
    // Claude Code names the file after the session id, and the id is also on most events; the file
    // name is the one that is there whatever the version writes.
    //
    // A subagent's lines carry its *session's* id, so the record is the one source that cannot answer
    // here: the agent's own id is on every line (`agentId`), and the file is named after it.
    let id = match parent {
        Some(_) => agent_id(&prefix).or_else(|| id_of_file(file)),
        None => session_id(&prefix).or_else(|| id_of_file(file)),
    };
    let Some(id) = id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let Some(cwd) = first_string(&prefix, "cwd") else {
        // Every event of a real transcript carries the cwd (`system`, `user` and `assistant` alike).
        // Without it a row could not say where the session ran, and the directory name cannot be
        // un-flattened back into a path: `C--Users-cxj-Desktop` has lost which separators were there.
        return Err(format!("会话 {} 里没有任何一行记录 cwd", file.display()));
    };
    let title = match parent {
        Some(_) => subagent_title(file, &prefix).unwrap_or_else(|| id.clone()),
        None => title_of(&prefix)
            .or_else(|| last_prompt(&prefix))
            .unwrap_or_else(|| id.clone()),
    };
    Ok(Some(AgentSession {
        tool: TOOL.to_string(),
        id,
        title,
        cwd,
        updated_at_ms: modified_ms(file).unwrap_or(0),
        parent_id: parent.map(str::to_string),
        stats: session_stats(file),
    }))
}

/// The id a transcript is filed under: the file is named after its session, and a subagent's after the
/// agent (`agent-<id>.jsonl`).
fn id_of_file(file: &Path) -> Option<String> {
    let stem = file.file_stem().and_then(|stem| stem.to_str())?;
    Some(stem.strip_prefix("agent-").unwrap_or(stem).to_string())
}

/// The agent id a subagent's lines carry, which is its id rather than its session's.
fn agent_id(prefix: &str) -> Option<String> {
    first_string(prefix, "agentId").filter(|id| !id.is_empty())
}

/// What to call a subagent: the description it was launched with, from the `agent-*.meta.json` beside
/// its transcript, then what the transcript itself yields.
///
/// The launched description is the name a person recognises ("探索 case-08 优化点"); the transcript's
/// first user line is the brief, which is long and starts with the same words for every helper of a run.
fn subagent_title(file: &Path, prefix: &str) -> Option<String> {
    let meta = file.with_extension("meta.json");
    if let Ok(text) = std::fs::read_to_string(&meta) {
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            if let Some(name) = named(value.get("description")) {
                return Some(name);
            }
            // `<agentType>` is the kind of helper (Explore, general-purpose): a poor name, but a name.
            if let Some(kind) = named(value.get("agentType")) {
                return Some(kind);
            }
        }
    }
    title_of(prefix).or_else(|| last_prompt(prefix))
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

/// Every file filed under an id, by the name Claude Code files it under.
///
/// *Every* one, not the first: Claude Code keeps a session's subagents under the project key of each
/// directory that session was used in, so the same agent id can be on disk more than once. Deleting
/// one copy would leave the other to reappear on the next read, which reads as "the delete did
/// nothing".
fn locate_all(root: &Path, id: &str) -> Result<Vec<Located>, String> {
    if id.is_empty() || id.contains(['/', '\\']) {
        // The id comes from the page and is about to be a path component.
        return Err(format!("非法的会话 id：{id}"));
    }
    let mut found = Vec::new();
    for project_dir in child_paths(root)? {
        if !project_dir.is_dir() {
            continue;
        }
        for (file, _parent) in session_files(&project_dir) {
            if id_of_file(&file).as_deref() != Some(id) {
                continue;
            }
            // A session owns the directory beside its transcript (its subagents); a subagent's file
            // owns nothing.
            let candidate = file.with_extension("");
            found.push(Located {
                file,
                owned_directory: candidate.is_dir().then_some(candidate),
            });
        }
    }
    if found.is_empty() {
        return Err(format!("Claude Code 里找不到会话 {id}"));
    }
    Ok(found)
}

pub(crate) fn delete_at(root: &Path, id: &str) -> Result<(), String> {
    if !root.is_dir() {
        return Err(format!(
            "这台机器上没有 Claude Code 的会话目录：{}。",
            root.display()
        ));
    }
    let located = locate_all(root, id)?;
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|e| format!("无法解析 Claude Code 会话目录 {}：{e}", root.display()))?;
    let mut targets = Vec::new();
    for copy in located {
        targets.push(copy.file);
        if let Some(directory) = copy.owned_directory {
            targets.push(directory);
        }
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
    Ok(locate_all(root, id).is_ok())
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
    fn lists_the_subagents_a_session_started_as_children() {
        let dir = tempfile::tempdir().expect("temp dir");
        let project = dir.path().join("C--Users-cxj-Desktop-dsh");
        write_session(&project, "s1", "");
        // A subagent's own transcript, one level down, exactly where Claude Code keeps them - and a
        // workflow's helper a level deeper than that.
        write_file(
            &project.join("s1/subagents"),
            "agent-abc.jsonl",
            "{\"type\":\"user\",\"agentId\":\"abc\",\"sessionId\":\"s1\",\"cwd\":\"C:\\\\x\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
        );
        write_file(
            &project.join("s1/subagents/workflows/run-1"),
            "agent-def.jsonl",
            "{\"type\":\"user\",\"agentId\":\"def\",\"sessionId\":\"s1\",\"cwd\":\"C:\\\\x\",\"message\":{\"role\":\"user\",\"content\":\"there\"}}\n",
        );
        let payload = list_at(dir.path()).expect("应能列出");
        assert_eq!(payload.sessions.len(), 3, "{:?}", payload.sessions);
        let parent = payload
            .sessions
            .iter()
            .find(|session| session.id == "s1")
            .expect("父会话");
        assert_eq!(parent.parent_id, None);
        let mut children: Vec<_> = payload
            .sessions
            .iter()
            .filter(|session| session.parent_id.is_some())
            .collect();
        children.sort_by(|a, b| a.id.cmp(&b.id));
        // The id is the agent's, not the session id the transcript repeats on every line: two rows
        // sharing one id would collapse into one.
        assert_eq!(
            children.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["abc", "def"]
        );
        for child in &children {
            assert_eq!(child.parent_id.as_deref(), Some("s1"));
            assert_eq!(child.cwd, "C:\\x");
        }
    }

    #[test]
    fn names_a_subagent_after_the_description_it_was_launched_with() {
        let dir = tempfile::tempdir().expect("temp dir");
        let project = dir.path().join("C--Users-cxj-Desktop-dsh");
        write_session(&project, "s1", "");
        write_file(
            &project.join("s1/subagents"),
            "agent-abc.jsonl",
            "{\"type\":\"user\",\"agentId\":\"abc\",\"sessionId\":\"s1\",\"cwd\":\"C:\\\\x\",\"isSidechain\":true,\"message\":{\"role\":\"user\",\"content\":\"你是只读探索代理。目标文件：…\"}}\n",
        );
        // What Claude Code writes beside it: the kind of helper, and the description it was launched
        // with - which is the name a person recognises, unlike the brief it was given.
        write_file(
            &project.join("s1/subagents"),
            "agent-abc.meta.json",
            "{\"agentType\":\"Explore\",\"description\":\"探索 case-08 优化点\"}\n",
        );
        let payload = list_at(dir.path()).expect("应能列出");
        let child = payload
            .sessions
            .iter()
            .find(|session| session.parent_id.is_some())
            .expect("子代理");
        assert_eq!(child.title, "探索 case-08 优化点");
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
    fn deleting_a_session_removes_the_copies_under_every_project_key() {
        // Claude Code keeps the same session under the project key of every directory it was used in.
        // Deleting one copy leaves the other, and the row comes back on the next read.
        let dir = tempfile::tempdir().expect("temp dir");
        for project in ["C--Users-cxj-Desktop", "C--Users-cxj-Desktop-dsh"] {
            let path = dir.path().join(project);
            write_session(&path, "s1", "");
            write_file(&path.join("s1/subagents"), "agent-abc.jsonl", "{}
");
        }
        delete_at(dir.path(), "s1").expect("应能删除");
        for project in ["C--Users-cxj-Desktop", "C--Users-cxj-Desktop-dsh"] {
            let path = dir.path().join(project);
            assert!(!path.join("s1.jsonl").exists(), "{project} 的转录还在");
            assert!(!path.join("s1").exists(), "{project} 的子代理目录还在");
        }
    }

    #[test]
    fn deleting_a_subagent_removes_every_copy_of_it() {
        let dir = tempfile::tempdir().expect("temp dir");
        for project in ["C--Users-cxj-Desktop", "C--Users-cxj-Desktop-dsh"] {
            let path = dir.path().join(project);
            write_session(&path, "s1", "");
            write_file(&path.join("s1/subagents"), "agent-abc.jsonl", "{}
");
        }
        delete_at(dir.path(), "abc").expect("应能删除");
        for project in ["C--Users-cxj-Desktop", "C--Users-cxj-Desktop-dsh"] {
            let path = dir.path().join(project);
            assert!(!path.join("s1/subagents/agent-abc.jsonl").exists(), "{project} 的副本还在");
            // The session it belonged to is untouched: only the subagent was asked for.
            assert!(path.join("s1.jsonl").exists(), "{project} 的会话被误删");
        }
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
    fn usage_events_come_from_every_assistant_message_of_every_transcript() {
        // Two sessions, three assistant messages, one user line and one line with no time: the store
        // is walked whole, because a session that ran for a week is a week of days.
        let dir = tempfile::tempdir().expect("temp dir");
        let one = dir.path().join("proj-a");
        write_file(
            &one,
            "s1.jsonl",
            &[
                r#"{"type":"user","timestamp":"2026-11-12T10:00:00.000Z","message":{"role":"user","content":"hi"}}"#,
                r#"{"type":"assistant","timestamp":"2026-11-12T10:00:10.000Z","message":{"model":"deepseek-v4.1-flash","usage":{"input_tokens":10,"output_tokens":2,"cache_read_input_tokens":100}}}"#,
                // No timestamp: there is no day to put it in, so it is not an event.
                r#"{"type":"assistant","message":{"model":"deepseek-v4.1-flash","usage":{"input_tokens":999}}}"#,
            ]
            .join("\n"),
        );
        let two = dir.path().join("proj-b");
        write_file(
            &two,
            "s2.jsonl",
            r#"{"type":"assistant","timestamp":"2026-11-13T09:00:00.000Z","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":5,"output_tokens":1}}}"#,
        );

        let report = usage_events_at(dir.path(), None);
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert_eq!(report.events.len(), 2, "the untimed line is not an event");
        assert!(report.events[0].at_ms < report.events[1].at_ms);
        assert_eq!(
            report.events[0].model.as_deref(),
            Some("deepseek-v4.1-flash")
        );
        // Claude Code's transcripts name no provider; nothing is invented for them.
        assert_eq!(report.events[0].provider, None);
        assert_eq!(report.events[0].tokens.input, 10);
        assert_eq!(report.events[0].tokens.cache_read, 100);
        assert_eq!(report.events[1].model.as_deref(), Some("claude-sonnet-4-5"));

        // A range start keeps what is inside it and drops the rest, which is what a window asks for.
        let ranged = usage_events_at(dir.path(), Some(report.events[1].at_ms));
        assert_eq!(ranged.events.len(), 1);
        assert_eq!(ranged.events[0].model.as_deref(), Some("claude-sonnet-4-5"));
    }

    #[test]
    fn a_store_that_is_not_there_has_no_events_and_nothing_to_report() {
        let dir = tempfile::tempdir().expect("temp dir");
        let report = usage_events_at(&dir.path().join("nope"), None);
        assert!(report.events.is_empty());
        assert!(report.failures.is_empty());
    }

    #[test]
    fn a_missing_root_lists_nothing_instead_of_failing() {
        // The reverse of what this test used to pin, and the reason is the panel: a machine with no
        // Claude Code store showed a red failure that told the user to check the installation, which
        // is a claim about their machine that a missing directory cannot support ("没找到不要说").
        // A tool with nothing to show answers with its own empty state.
        let dir = tempfile::tempdir().expect("temp dir");
        let payload = list_at(&dir.path().join("nope")).expect("缺少目录不是错误");
        assert!(payload.sessions.is_empty());
        assert!(payload.warnings.is_empty());
    }
}
