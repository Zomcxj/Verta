use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::stats::{self, iso_ms, SessionStats};
use super::types::{AgentSession, AgentSessionsPayload};

pub(crate) const TOOL: &str = "pi";

const MAX_TITLE_CHARS: usize = 80;
/// The head window is only used for the session header (id / cwd) and the **first**
/// user message (measured at under 77 KiB). The name does not rely on it: see
/// `latest_session_name`, which scans backwards from the end of the file.
const MAX_PREFIX_LINES: usize = 100_000;
const MAX_PREFIX_BYTES: u64 = 1024 * 1024;
/// Bytes read per step when scanning backwards for the name.
const NAME_SCAN_STEP: u64 = 4 * 1024 * 1024;
/// Upper bound on the backward scan (huge files are never read in full).
const NAME_SCAN_LIMIT: u64 = 256 * 1024 * 1024;
/// A name line can never be this long; anything longer is treated as a message body,
/// so a multi-megabyte line is never parsed (also the read limit for finding line
/// boundaries).
const MAX_NAME_LINE_BYTES: usize = 64 * 1024;
/// Text that always appears in a name line.
const NAME_NEEDLE: &[u8] = b"\"session_info\"";

pub(crate) fn default_root() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".pi/agent/sessions"))
}

pub(crate) fn list() -> Result<AgentSessionsPayload, String> {
    let root = default_root().ok_or("找不到用户主目录，无法定位 pi 会话目录")?;
    list_at(&root)
}

pub(crate) fn list_at(root: &Path) -> Result<AgentSessionsPayload, String> {
    if !root.is_dir() {
        // A store that is not there is a tool with nothing to show; see the same decision in
        // `claude::list_at`.
        return Ok(AgentSessionsPayload::default());
    }
    let mut sessions = Vec::new();
    let mut warnings = Vec::new();
    for project_dir in child_paths(root)? {
        if !project_dir.is_dir() {
            continue;
        }
        // Sessions first, then the runs they started: a run's `parent_id` has to be the id the parent is
        // *listed* under, and that is the one in the parent's header - the file is named after it, which
        // is where `id_in_stem` reads it back when the parent is gone.
        let mut parent_ids: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        let mut runs: Vec<(std::path::PathBuf, String)> = Vec::new();
        for (file, parent) in session_files(&project_dir) {
            let Some(stem) = parent else {
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
            runs.push((file, stem));
        }
        for (file, stem) in runs {
            let parent_id = parent_ids
                .get(&stem)
                .cloned()
                .or_else(|| id_in_stem(&stem).map(str::to_string))
                .unwrap_or_else(|| stem.clone());
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

/// The session files of one project directory, each with the session it belongs to when it is a run
/// rather than a session of its own.
///
/// pi writes a session as `<ISO>_<id>.jsonl`, a fork under `<stem>/forks`, and a subagent's run under
/// `<stem>/<run uuid>/run-0/session.jsonl`, beside the artifacts of the same run. A run's file *is* a
/// session - it has the `session` header, an id and a cwd - so it is read as one, carrying the
/// transcript it was started from as its parent; nothing deeper than a run's own directory is, which is
/// what keeps the artifacts out (`subagent_run_artifacts_are_not_sessions`).
fn session_files(project_dir: &Path) -> Vec<(PathBuf, Option<String>)> {
    let mut files = Vec::new();
    for child in child_paths(project_dir).unwrap_or_default() {
        if !child.is_dir() {
            files.push((child, None));
            continue;
        }
        // A fork records its own parent in its header; a run does not, and is filed under the session
        // it was started from.
        files.extend(
            child_paths(&child.join("forks"))
                .unwrap_or_default()
                .into_iter()
                .map(|file| (file, None)),
        );
        let stem = child
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_string);
        files.extend(run_files(&child).into_iter().map(|file| (file, stem.clone())));
    }
    files.retain(|(file, _)| file.extension().and_then(|ext| ext.to_str()) == Some("jsonl"));
    files
}

/// The `session.jsonl` of every run one session started: `<stem>/<run uuid>/run-*/`.
fn run_files(session_dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for run in child_paths(session_dir).unwrap_or_default() {
        if !run.is_dir() {
            continue;
        }
        for attempt in child_paths(&run).unwrap_or_default() {
            // `run-0`, `run-1`, ...: a run that was retried keeps each attempt.
            if !attempt.is_dir() {
                continue;
            }
            found.extend(
                child_paths(&attempt)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|file| file.is_file()),
            );
        }
    }
    found
}

/// Every usage event in this store, oldest first.
///
/// pi keeps no index either, so this walks the same projects and runs the list does (`session_files`)
/// and reads every assistant message. `since_ms` skips what a window's range leaves out.
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
        for (file, _) in session_files(&project) {
            collect_usage(&file, since_ms, &mut report);
        }
    }
    report.events.sort_by_key(|event| event.at_ms);
    report
}

/// One session file's events. A file that cannot be read is reported; a line that is not a usage
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
        let Some(usage) = super::usage::pi_usage_of_line(&value) else {
            continue;
        };
        let Some(at_ms) = message_stamp(&value) else {
            continue;
        };
        if since_ms.is_some_and(|since| at_ms < since) {
            continue;
        }
        report.events.push(super::usage::OwnedUsageEvent {
            at_ms,
            tool: TOOL,
            provider: usage.provider,
            model: usage.model,
            tokens: usage.tokens,
        });
    }
}

/// The session id inside a transcript's file name: pi writes `<ISO>_<id>.jsonl`.
fn id_in_stem(stem: &str) -> Option<&str> {
    stem.split_once('_')
        .map(|(_, id)| id)
        .filter(|id| !id.is_empty())
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
///
/// `parent` is the session this file was found under, for a run: pi's own header records a fork's
/// parent (`parentSession`) but not a subagent run's, which is filed under the session that started it.
fn read_session(file: &Path, parent: Option<&str>) -> Result<Option<AgentSession>, String> {
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
    let title = latest_session_name(file)
        .or_else(|| title_from_prefix(&prefix))
        .unwrap_or_else(|| {
            file.file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or(id)
                .to_string()
        });
    let stats = session_stats(file);
    Ok(Some(AgentSession {
        tool: TOOL.to_string(),
        id: id.to_string(),
        title,
        cwd,
        updated_at_ms: modified_ms(file).unwrap_or(0),
        parent_id: header
            .get("parentSession")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| parent.map(str::to_string)),
        stats,
    }))
}

/// Count turns and tokens in one session file, and when it last talked.
///
/// pi keeps no index, so every `message` line has to be seen: a user message counts as one turn,
/// and the `usage.totalTokens` of assistant messages is summed. Files can be tens of MB, so this is
/// the heaviest part of a list scan, but it only runs **while listing sessions** (in the same pass
/// that reads names), not every time a session is opened.
///
/// The whole file is read, and that is not an oversight. This used to read only the first 8 MiB, and
/// on a long-running session the cut showed up twice over - measured on this machine (2026-11-01) on
/// `ModelHarber`, a session still being written: the file was 44.9 MiB, the list said 103 turns
/// (the whole file has 262) and its last activity read 2026-10-02 (the end of the file says
/// 2026-11-01). A prefix is a window on the *beginning* of a transcript, and everything a list wants
/// here is about the end of it.
///
/// If it cannot be read, everything is `None`: the UI shows an em-dash instead of passing 0 off as a
/// real value.
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
        if value.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(message) = value.get("message") else {
            continue;
        };
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        if let Some(ms) = message_stamp(&value) {
            last_message_ms = Some(last_message_ms.map_or(ms, |kept: i64| kept.max(ms)));
        }
        if role == "user" {
            turns = turns.saturating_add(1);
        }
        if let Some(tokens) = stats::pi_tokens_of_message(&value) {
            token_parts.push(tokens);
        }
    }
    SessionStats {
        turns: Some(turns),
        tokens: stats::sum_tokens(token_parts),
        last_at_ms: last_message_ms,
    }
}

/// The timestamp on one `message` line: the message's own, else the line's ISO one.
fn message_stamp(value: &Value) -> Option<i64> {
    value
        .get("message")
        .and_then(|message| message.get("timestamp"))
        .and_then(Value::as_i64)
        .or_else(|| {
            value
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(iso_ms)
        })
}

fn parse_line(line: &str) -> Option<Value> {
    serde_json::from_str::<Value>(line).ok()
}

/// Title priority: the name the user last gave the session, then the first user
/// message. Both live in the file, so the name is looked up separately (it can
/// sit anywhere) and the message comes from the head window.
fn title_from_prefix(prefix: &str) -> Option<String> {
    let mut first_user: Option<String> = None;
    for value in prefix.lines().filter_map(parse_line) {
        match value.get("type").and_then(Value::as_str) {
            Some("session_info") => {
                if let Some(name) = session_info_name(&value) {
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

/// The name in one `session_info` record (an empty name does not count).
fn session_info_name(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) != Some("session_info") {
        return None;
    }
    value
        .get("name")
        .and_then(Value::as_str)
        .map(collapse_whitespace)
        .filter(|name| !name.is_empty())
}

/// A session name is written to the file **at the moment of renaming**, which in a long
/// session may be tens of MB in; reading only the head would miss it (and then fall
/// back to the first user message, so the list would not show the name you gave). So
/// this walks backwards in chunks from the end of the file and takes the `name` of the
/// **last** `session_info` (the most recent rename) stopping as soon as it is found
/// rather than reading the whole file.
fn latest_session_name(file: &Path) -> Option<String> {
    latest_session_name_with(file, NAME_SCAN_STEP, NAME_SCAN_LIMIT)
}

fn latest_session_name_with(file: &Path, step: u64, limit: u64) -> Option<String> {
    if step == 0 {
        return None;
    }
    let size = std::fs::metadata(file).ok()?.len();
    let floor = size.saturating_sub(limit);
    let mut end = size;
    while end > floor {
        let start = end.saturating_sub(step).max(floor);
        // First align both ends of the window to line boundaries: otherwise a needle
        // straddling a chunk boundary is split in two and never found.
        let (from, to) = align_to_lines(file, start, end, size);
        let bytes = read_bytes(file, from, to)?;
        // Search this chunk from the end; for each hit, read that whole line and parse it.
        let mut searched = bytes.len();
        while let Some(hit) = rfind(&bytes[..searched], NAME_NEEDLE) {
            if let Some(line) = full_line_at(file, from + hit as u64, size) {
                if let Some(name) = parse_line(&line).as_ref().and_then(session_info_name) {
                    return Some(name);
                }
            }
            searched = hit;
        }
        if start == 0 {
            break;
        }
        end = start;
    }
    None
}

/// Move both ends of `[start, end)` to the nearest newline after them (by at most
/// [`MAX_NAME_LINE_BYTES`]).
fn align_to_lines(file: &Path, start: u64, end: u64, size: u64) -> (u64, u64) {
    let reach = MAX_NAME_LINE_BYTES as u64;
    let from = if start == 0 {
        0
    } else {
        let back = start.saturating_sub(reach);
        match read_bytes(file, back, start).and_then(|bytes| {
            bytes
                .iter()
                .rposition(|b| *b == b'\n')
                .map(|i| back + i as u64 + 1)
        }) {
            Some(aligned) => aligned,
            None => start,
        }
    };
    let to = if end >= size {
        size
    } else {
        let forward = size.min(end + reach);
        match read_bytes(file, end, forward).and_then(|bytes| {
            bytes
                .iter()
                .position(|b| *b == b'\n')
                .map(|i| end + i as u64 + 1)
        }) {
            Some(aligned) => aligned,
            None => end,
        }
    };
    (from, to)
}

/// Read `[start, end)` from `file` (encoding is not fatal: the line still parses).
fn read_bytes(file: &Path, start: u64, end: u64) -> Option<Vec<u8>> {
    use std::io::{Seek, SeekFrom};
    let mut handle = std::fs::File::open(file).ok()?;
    handle.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((end - start) as usize);
    handle.take(end - start).read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// Position of the last occurrence of `needle` in `haystack` (byte level, ignoring
/// character boundaries).
fn rfind(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).rposition(|w| w == needle)
}

/// Read the whole line containing byte `absolute` (extending at most
/// [`MAX_NAME_LINE_BYTES`] in each direction).
///
/// This is independent of the backward-scan chunk boundaries: a line cut in half by a
/// chunk is still read whole from the file. A line that is too long (meaning the hit was
/// a message body mentioning the field) returns None so the caller keeps searching
/// further back.
fn full_line_at(file: &Path, absolute: u64, size: u64) -> Option<String> {
    let reach = MAX_NAME_LINE_BYTES as u64;
    let from = absolute.saturating_sub(reach);
    let to = size.min(absolute + reach);
    let bytes = read_bytes(file, from, to)?;
    let rel = (absolute - from) as usize;
    if rel > bytes.len() {
        return None;
    }
    let line_start = bytes[..rel]
        .iter()
        .rposition(|b| *b == b'\n')
        .map_or(0, |i| i + 1);
    let line_end = bytes[rel..]
        .iter()
        .position(|b| *b == b'\n')
        .map_or(bytes.len(), |i| rel + i);
    if line_end <= line_start || line_end - line_start > MAX_NAME_LINE_BYTES {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes[line_start..line_end]).into_owned())
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

const MAX_HEADER_BYTES: u64 = 16 * 1024;

/// Where a session id actually lives, proved by the same scan the list uses.
struct Located {
    file: PathBuf,
    /// A top-level session owns `<stem>/`: its subagent runs and its forks.
    owned_directory: Option<PathBuf>,
}

pub(crate) fn delete_at(root: &Path, id: &str) -> Result<(), String> {
    if !root.is_dir() {
        return Err(format!(
            "这台机器上没有 pi 的会话目录：{}。",
            root.display()
        ));
    }
    let located = locate(root, id)?;
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|e| format!("无法解析 pi 会话目录 {}：{e}", root.display()))?;
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
                "拒绝删除 pi 会话目录之外的路径：{}",
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

/// Rename a session: append a `session_info` line at the end of the file, exactly
/// what pi's own `/name` does.
///
/// A new line is appended rather than an old one edited, because pi takes the **last**
/// `session_info` when reading; that also means history is never rewritten (if a name
/// goes wrong, the old one is still in the file).
pub(crate) fn rename_at(root: &Path, id: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if let Some(problem) = name_problem(name) {
        return Err(problem);
    }
    let located = locate(root, id)?;
    use std::io::Write;
    let mut handle = std::fs::OpenOptions::new()
        .append(true)
        .open(&located.file)
        .map_err(|e| format!("打开会话文件失败：{e}"))?;
    let line = serde_json::json!({
        "type": "session_info",
        "timestamp": now_iso(),
        "name": name,
    });
    writeln!(handle, "{line}").map_err(|e| format!("写入会话名失败：{e}"))?;
    handle
        .sync_all()
        .map_err(|e| format!("写入会话名失败：{e}"))?;
    Ok(())
}

/// Message for an invalid name. The name becomes one line of JSON, so neither empty
/// nor over-long values may be written.
pub(crate) fn name_problem(name: &str) -> Option<String> {
    if name.is_empty() {
        return Some("会话名不能为空".to_string());
    }
    if name.chars().count() > MAX_TITLE_CHARS {
        return Some(format!("会话名最多 {MAX_TITLE_CHARS} 个字"));
    }
    None
}

/// `2026-10-22T03:04:05.678Z`: the shape pi writes its own timestamps in.
fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format_iso(now as i64)
}

/// Milliseconds → `YYYY-MM-DDThh:mm:ss.sssZ` (UTC; good enough without a dependency).
fn format_iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3_600,
        (rem % 3_600) / 60,
        rem % 60
    )
}

/// Days since 1970-01-01 → civil date (the inverse of `days_from_civil`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { y + 1 } else { y }, month, day)
}

/// The id a session file declares in its first line, without resolving anything
/// else, so a session whose header cannot become a full record is still
/// locatable.
fn session_id_of(file: &Path) -> Option<String> {
    let prefix = read_prefix_with(file, MAX_HEADER_BYTES, 1).ok()?;
    let header = prefix.lines().next().and_then(parse_line)?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    header.get("id").and_then(Value::as_str).map(str::to_string)
}

fn locate(root: &Path, id: &str) -> Result<Located, String> {
    for project_dir in child_paths(root)? {
        if !project_dir.is_dir() {
            continue;
        }
        for (file, _parent) in session_files(&project_dir) {
            if session_id_of(&file).as_deref() != Some(id) {
                continue;
            }
            let is_fork = file
                .parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                == Some("forks");
            let owned_directory = if is_fork {
                None
            } else {
                let candidate = file.with_extension("");
                candidate.is_dir().then_some(candidate)
            };
            return Ok(Located {
                file,
                owned_directory,
            });
        }
    }
    Err(format!("pi 里找不到会话 {id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    // The date arithmetic behind `iso_ms` moved to `stats`, where both tools' timestamps share it.
    use super::stats::days_from_civil;

    fn write_file(dir: &Path, name: &str, body: &str) -> PathBuf {
        std::fs::create_dir_all(dir).expect("create dir");
        let path = dir.join(name);
        std::fs::write(&path, body).expect("write");
        path
    }

    /// Writes a session file the way pi names them: `<ISO>_<uuid>.jsonl`.
    fn write_session(dir: &Path, stem: &str, id: &str) -> PathBuf {
        write_file(
            dir,
            &format!("{stem}.jsonl"),
            &format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"cwd\":\"F:\\\\VibeCoding_workspace\\\\ModelHarbor\"}}\n"
            ),
        )
    }

    #[test]
    fn renaming_appends_a_name_line_that_wins_on_the_next_read() {
        let dir = tempfile::tempdir().expect("temp dir");
        let project = dir.path().join("--F--x--");
        let path = write_session(&project, "2026-09-09T05-47-23-952Z_s1", "s1");
        rename_at(dir.path(), "s1", "  新名字  ").expect("应能改名");
        // The name read back is the new one, and the old content was not rewritten
        // (appended, not replaced).
        let session = read_session(&path, None).expect("read").expect("a session");
        assert_eq!(session.title, "新名字");
        let body = std::fs::read_to_string(&path).expect("read file");
        assert_eq!(body.lines().count(), 2, "第一行还是会话头，新名字追加在后面");
        assert!(body.lines().nth(1).is_some_and(|line| line.contains("\"session_info\"")));
        assert_eq!(name_problem(""), Some("会话名不能为空".to_string()));
        assert!(name_problem(&"好".repeat(MAX_TITLE_CHARS + 1)).is_some());
        assert!(rename_at(dir.path(), "nope", "x").is_err(), "id 不存在要报错");
    }

    #[test]
    fn iso_formatting_round_trips_through_the_parser() {
        for ms in [0, 1_709_164_800_000, 1_792_065_286_288, 1_800_000_000_123] {
            let text = format_iso(ms);
            assert_eq!(iso_ms(&text), Some(ms), "{text}");
        }
    }

    #[test]
    fn deletes_the_session_file_and_its_artifact_directory_only() {
        let root = tempfile::tempdir().expect("temp dir");
        let project = root.path().join("--F--VibeCoding_workspace-ModelHarbor--");
        let stem = "2026-09-12T13-20-04-533Z_01a095c6";
        let file = write_session(&project, stem, "01a095c6");
        let artifacts = project.join(stem);
        write_file(&artifacts.join("00e278ab/run-0"), "output.jsonl", "{}\n");
        let sibling = write_session(&project, "2026-10-17T02-24-43-071Z_01a147ad", "01a147ad");
        write_file(&project.join("subagent-artifacts"), "run-0.jsonl", "{}\n");

        delete_at(root.path(), "01a095c6").expect("delete");

        assert!(!file.exists(), "session file should be gone");
        assert!(!artifacts.exists(), "the session's artifact directory goes too");
        assert!(sibling.exists(), "a sibling session must survive");
        assert!(
            project.join("subagent-artifacts").exists(),
            "the shared artifact directory is never a target"
        );
        assert!(!exists_at(root.path(), "01a095c6").expect("exists"));
    }

    #[test]
    fn deleting_a_fork_leaves_the_session_it_branched_from_alone() {
        let root = tempfile::tempdir().expect("temp dir");
        let project = root.path().join("--F--x--");
        let stem = "2026-09-09T10-55-18-316Z_01a085ce";
        let parent = write_session(&project, stem, "01a085ce");
        let fork = write_session(
            &project.join(stem).join("forks"),
            "2026-09-09T13-14-24-105Z_01a0864e",
            "01a0864e",
        );

        delete_at(root.path(), "01a0864e").expect("delete");

        assert!(!fork.exists());
        assert!(parent.exists());
        assert!(
            project.join(stem).exists(),
            "a fork never owns the parent's artifacts"
        );
    }

    #[test]
    fn an_unknown_id_changes_nothing() {
        let root = tempfile::tempdir().expect("temp dir");
        let project = root.path().join("--F--x--");
        let file = write_session(&project, "2026-10-17T02-00-00-000Z_keep", "keep");
        let error = delete_at(root.path(), "nope").expect_err("should fail");
        assert!(error.contains("nope"), "unexpected error: {error}");
        assert!(file.exists());
    }

    #[test]
    fn refuses_an_id_that_points_outside_the_root() {
        let root = tempfile::tempdir().expect("temp dir");
        std::fs::create_dir_all(root.path().join("--F--x--")).expect("dir");
        let outside = root
            .path()
            .parent()
            .expect("parent")
            .join("verta-outside-probe.jsonl");
        std::fs::write(&outside, "{}\n").expect("write");
        for id in ["..", "../verta-outside-probe", "a/b", "a\\b"] {
            assert!(delete_at(root.path(), id).is_err(), "should reject {id:?}");
        }
        assert!(outside.exists(), "nothing outside the root may be touched");
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn a_missing_root_is_an_error_not_a_silent_success() {
        let root = tempfile::tempdir().expect("temp dir");
        let error = delete_at(&root.path().join("nope"), "01a085ce").expect_err("should fail");
        assert!(error.contains("pi") || error.contains("01a085ce"), "{error}");
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
        // Locks why the name is looked up from the end of the file: pi writes it
        // when the user names the session, which can be megabytes in.
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
        assert_eq!(latest_session_name(&path).as_deref(), Some("晚来的名字"));
    }

    #[test]
    fn the_newest_rename_wins_over_an_earlier_one() {
        let dir = tempfile::tempdir().expect("temp dir");
        let body = format!(
            "{}\n{}\n{}\n",
            r#"{"type":"session","id":"s1","cwd":"F:\\x"}"#,
            r#"{"type":"session_info","name":"第一次起的名字"}"#,
            r#"{"type":"session_info","name":"后来改的名字"}"#,
        );
        let path = write_file(dir.path(), "s.jsonl", &body);
        assert_eq!(latest_session_name(&path).as_deref(), Some("后来改的名字"));
    }

    #[test]
    fn a_name_megabytes_into_the_file_is_found_by_the_backward_scan() {
        // 1.2 MiB of filler puts the name past MAX_PREFIX_BYTES (1 MiB), which is
        // exactly the case that used to fall back to the first user message.
        let dir = tempfile::tempdir().expect("temp dir");
        let mut body = String::from(r#"{"type":"session","id":"s1","cwd":"F:\\x"}"#);
        body.push('\n');
        body.push_str(r#"{"type":"message","message":{"role":"user","content":"第一条消息"}}"#);
        body.push('\n');
        while body.len() < 1_200_000 {
            body.push_str(&"f".repeat(4096));
            body.push('\n');
        }
        body.push_str(r#"{"type":"session_info","name":"深在文件里的名字"}"#);
        body.push('\n');
        let path = write_file(dir.path(), "s.jsonl", &body);
        let session = read_session(&path, None).expect("read").expect("a session");
        assert_eq!(session.title, "深在文件里的名字");
    }

    #[test]
    fn a_name_line_split_across_chunk_boundaries_is_still_found() {
        // A tiny step makes the name line straddle a chunk boundary: the full line is
        // read from the file, so boundaries do not matter.
        let dir = tempfile::tempdir().expect("temp dir");
        let name_line = r#"{"type":"session_info","name":"跨界线的名字"}"#;
        for filler in 0..24usize {
            let body = format!(
                "{}\n{}\n{}\n",
                r#"{"type":"session","id":"s1","cwd":"F:\\x"}"#,
                "y".repeat(filler),
                name_line,
            );
            let path = write_file(dir.path(), "s.jsonl", &body);
            assert_eq!(
                latest_session_name_with(&path, 40, 1 << 20).as_deref(),
                Some("跨界线的名字"),
                "filler {filler}"
            );
        }
    }

    #[test]
    fn a_line_too_long_to_be_a_name_is_skipped() {
        // When a message body quotes this text the hit is an over-long line: it is not a
        // name, so keep searching backwards.
        let dir = tempfile::tempdir().expect("temp dir");
        let long_message = format!(
            r#"{{"type":"message","message":{{"role":"user","content":"{}"}}}}"#,
            "讲 \"session_info\" 这个词 ".repeat(4000),
        );
        let body = format!(
            "{}\n{}\n{}\n",
            r#"{"type":"session","id":"s1","cwd":"F:\\x"}"#,
            long_message,
            r#"{"type":"session_info","name":"真正的名字"}"#,
        );
        let path = write_file(dir.path(), "s.jsonl", &body);
        assert_eq!(latest_session_name(&path).as_deref(), Some("真正的名字"));
    }

    #[test]
    fn the_word_inside_a_message_is_not_a_name() {
        let dir = tempfile::tempdir().expect("temp dir");
        let body = concat!(
            r#"{"type":"session","id":"s1","cwd":"F:\\x"}"#,
            "\n",
            r#"{"type":"message","message":{"role":"user","content":"我在讲 \"type\":\"session_info\" 这个字段"}}"#,
            "\n",
        );
        let path = write_file(dir.path(), "s.jsonl", body);
        assert_eq!(latest_session_name(&path), None);
        assert_eq!(
            read_session(&path, None).expect("read").expect("a session").title,
            "我在讲 \"type\":\"session_info\" 这个字段"
        );
    }

    #[test]
    fn a_session_without_a_name_has_none() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = write_file(
            dir.path(),
            "s.jsonl",
            "{\"type\":\"session\",\"id\":\"s1\",\"cwd\":\"F:\\\\x\"}\n",
        );
        assert_eq!(latest_session_name(&path), None);
    }

    #[test]
    fn turns_tokens_and_the_last_talk_count_user_messages_and_usage() {
        let dir = tempfile::tempdir().expect("temp dir");
        let body = concat!(
            r#"{"type":"session","id":"s1","cwd":"F:\\x"}"#,
            "\n",
            r#"{"type":"message","message":{"role":"user","content":"第一句","timestamp":1000}}"#,
            "\n",
            r#"{"type":"message","message":{"role":"assistant","usage":{"totalTokens":120},"timestamp":2000}}"#,
            "\n",
            r#"{"type":"message","message":{"role":"user","content":"第二句","timestamp":3000}}"#,
            "\n",
            r#"{"type":"message","message":{"role":"assistant","usage":{"input":10,"output":5},"timestamp":4000}}"#,
            "\n",
            r#"{"type":"session_info","name":"后来的名字"}"#,
            "\n",
        );
        let path = write_file(dir.path(), "s.jsonl", body);
        let stats = session_stats(&path);
        assert_eq!(stats.turns, Some(2), "两条用户消息就是两轮");
        assert_eq!(stats.tokens, Some(135), "120 + (10+5)");
        assert_eq!(stats.last_at_ms, Some(4000));
    }

    #[test]
    fn a_session_past_the_old_prefix_window_is_counted_and_dated_to_its_end() {
        // The bug this is written against, measured on this machine (2026-11-01) on a session that
        // was still being written: its file was 44.9 MiB, `session_stats` read only the first 8 MiB,
        // and the list showed 103 turns and a last activity of 2026-10-02 while the whole file held
        // 262 turns and ended on 2026-11-01. A prefix is a window on the beginning of a transcript,
        // and turns and last-talk are both facts about its end.
        let dir = tempfile::tempdir().expect("temp dir");
        let mut body = String::from(r#"{"type":"session","id":"s1","cwd":"F:\\x"}"#);
        body.push('\n');
        // Enough filler to pass 8 MiB, so a prefix reader would stop inside it.
        let filler = format!(
            r#"{{"type":"message","message":{{"role":"user","content":"{}","timestamp":1000}}}}"#,
            "填".repeat(400)
        );
        while body.len() < 9 * 1024 * 1024 {
            body.push_str(&filler);
            body.push('\n');
        }
        let filler_turns = body.matches("\"role\":\"user\"").count();
        // And the newest message, well past the old cut.
        body.push_str(
            r#"{"type":"message","message":{"role":"user","content":"最新一句","timestamp":9000}}"#,
        );
        body.push('\n');
        let path = write_file(dir.path(), "s.jsonl", &body);
        assert!(
            std::fs::metadata(&path).expect("meta").len() > MAX_PREFIX_BYTES * 8,
            "the fixture has to be longer than the old prefix window"
        );

        let stats = session_stats(&path);
        assert_eq!(
            stats.turns,
            Some(filler_turns as u32 + 1),
            "every user message counts, including the ones past the old cut"
        );
        assert_eq!(stats.last_at_ms, Some(9000), "the last talk is the end of the file");
    }

    #[test]
    fn a_session_with_no_messages_has_zero_turns_but_no_tokens() {
        // The turn count is definitely 0; with no token data it must be "unknown", not a
        // fake 0.
        let dir = tempfile::tempdir().expect("temp dir");
        let path = write_file(
            dir.path(),
            "s.jsonl",
            "{\"type\":\"session\",\"id\":\"s1\",\"cwd\":\"F:\\\\x\"}\n",
        );
        let stats = session_stats(&path);
        assert_eq!(stats.turns, Some(0));
        assert_eq!(stats.tokens, None);
        assert_eq!(stats.last_at_ms, None);
    }

    #[test]
    fn iso_timestamps_parse_without_pulling_in_a_date_library() {
        // 2026-09-09T05:48:06.288Z
        let ms = iso_ms("2026-09-09T05:48:06.288Z").expect("应能解析");
        assert_eq!(ms % 1000, 288);
        assert_eq!(
            iso_ms("1970-01-01T00:00:00Z"),
            Some(0),
            "epoch 本身要算对"
        );
        assert_eq!(
            ms / 1000,
            days_from_civil(2026, 9, 9) * 86_400 + 5 * 3600 + 48 * 60 + 6
        );
        assert_eq!(iso_ms("2024-02-29T00:00:00.000Z"), Some(1_709_164_800_000), "闰日");
        assert_eq!(iso_ms("不是时间"), None);
        assert_eq!(iso_ms("2026-13-01T00:00:00Z"), None, "月份越界不猜");
    }

    #[test]
    fn complete_lines_drops_the_seams_unless_they_are_the_file_edges() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = write_file(dir.path(), "s.jsonl", "aaa\nbbb\nccc\n");
        // A line cut in the middle is still read whole (line boundaries come from the
        // file).
        assert_eq!(full_line_at(&path, 5, 12).as_deref(), Some("bbb"));
        assert_eq!(full_line_at(&path, 0, 12).as_deref(), Some("aaa"));
        assert_eq!(full_line_at(&path, 10, 12).as_deref(), Some("ccc"));
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
    fn lists_a_subagent_run_as_a_child_of_the_session_that_started_it() {
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
        // Real layout: <stem>/<run uuid>/run-0/session.jsonl - a session of its own (header, id, cwd),
        // filed under the session that started it.
        write_file(
            &project.join("2026-09-12T13-20-04-533Z_01a095c6/00e278ab/run-0"),
            "session.jsonl",
            concat!(
                r#"{"type":"session","version":3,"id":"01a0aaaa","cwd":"F:\\x"}"#,
                "\n",
            ),
        );
        let payload = list_at(root.path()).expect("list");
        assert_eq!(payload.sessions.len(), 2, "{:?}", payload.sessions);
        assert!(payload.warnings.is_empty(), "{:?}", payload.warnings);
        let child = payload
            .sessions
            .iter()
            .find(|session| session.id == "01a0aaaa")
            .expect("子代理运行");
        // The run's own header says nothing about its parent; the directory does.
        assert_eq!(child.parent_id.as_deref(), Some("01a095c6"));
        let parent = payload
            .sessions
            .iter()
            .find(|session| session.id == "01a095c6")
            .expect("父会话");
        assert_eq!(parent.parent_id, None);
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
    fn usage_events_come_from_every_message_of_every_run() {
        // The real layout: <project>/<session>/<run uuid>/run-0/session.jsonl.
        let dir = tempfile::tempdir().expect("temp dir");
        let run = dir
            .path()
            .join("--proj--")
            .join("2026-11-12T10-00-00-000Z_01a0")
            .join("6f0a")
            .join("run-0");
        write_file(
            &run,
            "session.jsonl",
            &[
                r#"{"type":"message","message":{"role":"user","content":"hi"}}"#,
                r#"{"type":"message","message":{"role":"assistant","provider":"openai_agentrouter","model":"gpt-5.6-sol","timestamp":1794500000000,"usage":{"input":100,"output":20,"cacheRead":5,"cacheWrite":1,"totalTokens":126}}}"#,
                r#"{"type":"message","message":{"role":"assistant","provider":"openai_agentrouter","model":"gpt-5.6-sol","timestamp":1794580000000,"usage":{"totalTokens":900}}}"#,
                // A day later than the integer-stamped one above, so the sort is unambiguous.
                r#"{"type":"message","timestamp":"2026-11-14T05:00:00.000Z","message":{"role":"assistant","model":"gpt-5.6-sol","usage":{"input":1}}}"#,
            ]
            .join("\n"),
        );

        let report = usage_events_at(dir.path(), None);
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert_eq!(report.events.len(), 3, "the user line is not an event");
        assert_eq!(report.events[0].at_ms, 1794500000000);
        assert_eq!(report.events[0].provider.as_deref(), Some("openai_agentrouter"));
        assert_eq!(report.events[0].model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(report.events[0].tokens.total(), 126);
        // pi's own total with no breakdown is still a counted event.
        assert_eq!(report.events[1].tokens.unsplit, 900);
        // The line-level ISO timestamp is used when the message carries none.
        assert_eq!(report.events[2].tokens.input, 1);
        assert!(report.events[0].at_ms < report.events[1].at_ms);
        assert!(report.events[1].at_ms < report.events[2].at_ms);

        let ranged = usage_events_at(dir.path(), Some(1794580000000));
        assert_eq!(ranged.events.len(), 2);
        assert_eq!(ranged.events[0].tokens.unsplit, 900);
    }

    #[test]
    fn a_missing_root_lists_nothing_instead_of_failing() {
        // See the same reversal in `claude`: a store that is not there is a tool with nothing to
        // show, not a failure of the panel.
        let root = tempfile::tempdir().expect("temp dir");
        let payload = list_at(&root.path().join("nope")).expect("a missing directory is not an error");
        assert!(payload.sessions.is_empty());
        assert!(payload.warnings.is_empty());
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