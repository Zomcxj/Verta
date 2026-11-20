//! dsh's usage: one log per session, `~/.dsh/sessions/<project>/<session>/session[.vN].jsonl[.zstd]`.
//!
//! Only usage is read here - no session list, no delete, no rename. The log is a sequence of
//! `{type, seq, time, data}` records, one per line, and two kinds are model calls that carry
//! `data.usage`: `assistant/message` (an answer) and `compaction/summary` (the summarisation run when
//! a conversation is compacted). Everything else - turns, steps, tool calls, titles, sandbox and
//! approval changes - is bookkeeping this reader steps over.
//!
//! The log is appended to, and dsh compresses each append on its own: a real file here holds
//! thousands of zstd frames back to back (8,599 frames in the largest one, 9.8 MB for 636 records).
//! Decompressing only the first frame would read the session header and nothing else, so the whole
//! file goes through one streaming decoder.
//!
//! `~/.dsh/storages/session_projcache.json` is not read: it caches the session that is currently
//! open (on this machine: one entry, 243K tokens, against 35 logs on disk), so it is a view of the
//! editor's state rather than a record of what was spent.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::usage::{OwnedUsageEvent, UsageReadReport};
use super::usage_cache::FileEvent;

pub(crate) const TOOL: &str = "dsh";

/// Where dsh keeps its sessions: `$DSH_HOME/sessions` when that is set, otherwise
/// `~/.dsh/sessions`.
///
/// `DSH_HOME` is dsh's own home directory (the log path is built from it as `<home>/sessions`), not
/// the sessions directory itself, which is how the other readers of these logs resolve it too. A
/// variable that already points at a sessions directory is taken as one, because both spellings are
/// in the wild and the difference is one `is_dir`.
pub(crate) fn usage_roots() -> Vec<PathBuf> {
    let home = std::env::var_os("DSH_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".dsh")));
    let Some(home) = home else {
        return Vec::new();
    };
    let sessions = home.join("sessions");
    let root = if sessions.is_dir() { sessions } else { home };
    if root.is_dir() {
        vec![root]
    } else {
        Vec::new()
    }
}

/// Every usage event in these stores, oldest first.
///
/// `since_ms` skips what a range leaves out. A log that cannot be opened or decoded is reported as a
/// failure rather than quietly skimmed over, because a hole in these numbers would otherwise look
/// like a day the agent was not used.
pub(crate) fn usage_events_at(
    roots: &[PathBuf],
    since_ms: Option<i64>,
    cache: &mut super::usage_cache::UsageFileCache,
) -> UsageReadReport {
    let mut logs = Vec::new();
    for root in roots {
        logs.extend(session_logs(root));
    }
    // Whole files rather than tails: these logs are zstd frames and their parser carries state
    // across lines, so there is no byte offset to resume from. The newest log of a session is a
    // rewritten file, not an appended one, which is what the fingerprint is for.
    cache.read_whole(TOOL, &logs, since_ms, parse_log)
}

/// One log per session: the newest one the session directory holds.
fn session_logs(root: &Path) -> Vec<PathBuf> {
    let mut logs = Vec::new();
    let Ok(projects) = std::fs::read_dir(root) else {
        return logs;
    };
    for project in projects.filter_map(Result::ok) {
        let project = project.path();
        if !project.is_dir() {
            continue;
        }
        let Ok(sessions) = std::fs::read_dir(&project) else {
            continue;
        };
        for session in sessions.filter_map(Result::ok) {
            let session = session.path();
            if !session.is_dir() {
                continue;
            }
            let Ok(files) = std::fs::read_dir(&session) else {
                continue;
            };
            let mut best: Option<(u32, u128, PathBuf)> = None;
            for file in files.filter_map(Result::ok) {
                let path = file.path();
                if !path.is_file() {
                    continue;
                }
                let Some(version) = log_version(&path) else {
                    continue;
                };
                let modified = file
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |since| since.as_millis());
                let newer = match best.as_ref() {
                    None => true,
                    Some((best_version, best_modified, _)) => {
                        (version, modified) > (*best_version, *best_modified)
                    }
                };
                if newer {
                    best = Some((version, modified, path));
                }
            }
            if let Some((_, _, path)) = best {
                logs.push(path);
            }
        }
    }
    logs
}

/// The version on a session log's name, when the name is one at all.
///
/// dsh writes `session.jsonl.zstd` and, when it rewrites the log, a numbered
/// `session.v4.jsonl.zstd` beside it: the numbered file is the newer record of the same session, so
/// the highest number wins and the stale copy is not read twice. Anything else in the directory
/// (`session.meta.json` and friends) is not a log and returns `None`.
fn log_version(path: &Path) -> Option<u32> {
    let name = path.file_name()?.to_str()?;
    let name = name.strip_suffix(".zstd").unwrap_or(name);
    let rest = name.strip_suffix(".jsonl")?.strip_prefix("session")?;
    if rest.is_empty() {
        return Some(0);
    }
    let number = rest.strip_prefix(".v")?;
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    number.parse().ok()
}

/// One log's events, and what went wrong reading it. A line that is not an answer, or carries no
/// time, is skipped: no timestamp means no day to put it in, and counting it in the wrong day is
/// worse than not counting it.
///
/// What was read is returned even when the read broke off: a log that stops being readable half way
/// contributes everything above the break, and the caller reports the break beside it.
fn parse_log(log: &Path) -> (Vec<FileEvent>, Option<String>) {
    let file = match std::fs::File::open(log) {
        Ok(file) => file,
        Err(error) => {
            return (
                Vec::new(),
                Some(format!("无法打开 dsh 会话 {}：{error}", log.display())),
            )
        }
    };
    let reader: Box<dyn BufRead> = if log.extension().and_then(|ext| ext.to_str()) == Some("zstd") {
        // The streaming decoder walks every frame in the file; `single_frame` is what would stop it
        // at the first one, and the first one is just the header.
        match zstd::stream::read::Decoder::new(file) {
            Ok(decoder) => Box::new(BufReader::new(decoder)),
            Err(error) => {
                return (
                    Vec::new(),
                    Some(format!("无法解开 dsh 会话 {}：{error}", log.display())),
                )
            }
        }
    } else {
        Box::new(BufReader::new(file))
    };

    let mut found: Vec<(Option<u64>, OwnedUsageEvent)> = Vec::new();
    let mut failure = None;
    // A forked session's log starts with the prefix it inherited from its parent, which the parent's
    // own log already counts. dsh ends that prefix with `session/end-seed` carrying
    // `inherited: true`; everything at or before it belongs to the parent. No session on this machine
    // is seeded (`isSeeded` is false in all 35 headers), so this only matters the day one is forked.
    let mut inherited_through: Option<u64> = None;
    // The session's current model, from its own `model/selection` records. A compaction runs on that
    // model and its record does not repeat the routing, so this is what keeps its tokens on a name
    // instead of on an unnamed row.
    let mut selection: Option<(Option<String>, Option<String>)> = None;
    let mut line = String::new();
    let mut reader = reader;
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) => {
                failure = Some(format!("读取 dsh 会话 {} 中断：{error}", log.display()));
                break;
            }
        }
        // Almost every record is bookkeeping (2,000+ of them in one session), so the cheap check
        // runs first and only the answers, the selections and the seed marker are parsed.
        if !line.contains("\"usage\"")
            && !line.contains("end-seed")
            && !line.contains("model/selection")
        {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim_end()) else {
            continue;
        };
        let seq = value.get("seq").and_then(serde_json::Value::as_u64);
        if value.get("type").and_then(serde_json::Value::as_str) == Some("model/selection") {
            let data = value.get("data");
            selection = Some((
                data.and_then(|data| data.get("provider"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                data.and_then(|data| data.get("model"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
            ));
            continue;
        }
        if value.get("type").and_then(serde_json::Value::as_str) == Some("session/end-seed") {
            let inherited = value
                .get("data")
                .and_then(|data| data.get("inherited"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            if inherited {
                if let Some(seq) = seq {
                    inherited_through = Some(inherited_through.map_or(seq, |seen| seen.max(seq)));
                }
            }
            continue;
        }
        let Some(usage) = super::usage::dsh_usage_of_line(&value) else {
            continue;
        };
        let Some(at_ms) = value.get("time").and_then(serde_json::Value::as_i64) else {
            continue;
        };
        if at_ms <= 0 {
            continue;
        }
        let (provider, model) = match (usage.provider, usage.model) {
            (None, None) => selection.clone().unwrap_or((None, None)),
            (provider, model) => (provider, model),
        };
        found.push((
            seq,
            OwnedUsageEvent {
                at_ms,
                tool: TOOL,
                provider,
                model,
                tokens: usage.tokens,
            },
        ));
    }
    if let Some(cutoff) = inherited_through {
        found.retain(|(seq, _)| seq.is_none_or(|seq| seq > cutoff));
    }
    (
        found
            .into_iter()
            .map(|(_, event)| FileEvent { key: None, event })
            .collect(),
        failure,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &[u8]) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(path, body).expect("write");
    }

    /// Two records, each compressed on its own, concatenated: this is the shape dsh leaves behind
    /// after two appends, and reading only the first frame would lose the second.
    fn two_frames(first: &str, second: &str) -> Vec<u8> {
        let mut out = zstd::stream::encode_all(first.as_bytes(), 3).expect("frame");
        out.extend(zstd::stream::encode_all(second.as_bytes(), 3).expect("frame"));
        out
    }

    fn answer(seq: u64, at: i64, input: u64, output: u64, cache_read: u64) -> String {
        serde_json::json!({
            "type": "assistant/message",
            "seq": seq,
            "time": at,
            "data": {
                "usage": {
                    "inputTokens": input,
                    "outputTokens": output,
                    "cacheReadTokens": cache_read,
                    "cacheWriteTokens": 0,
                    "totalTokens": input + output + cache_read,
                },
                "message": {
                    "source": {
                        "kind": "model",
                        "provider": "deepseek-account",
                        "model": "deepseek-flash",
                    },
                },
            },
        })
        .to_string()
    }

    #[test]
    fn every_frame_of_a_compressed_log_is_read() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("sessions");
        let log = root
            .join("--F-proj--")
            .join("session-1")
            .join("session.v4.jsonl.zstd");
        let header = r#"{"type":"session","version":4,"id":"session-1","createdAt":1791083494686,"isSeeded":false}"#;
        let body = [
            format!("{header}\n"),
            format!("{}\n", answer(1, 1_791_083_553_999, 306, 265, 9_088)),
            r#"{"type":"tool/call","seq":2,"time":1791083554000,"data":{}}"#.to_string() + "\n",
            format!("{}\n", answer(3, 1_791_083_559_303, 16_605, 234, 9_600)),
        ];
        // Three appends: the header, then one answer each.
        let mut bytes = zstd::stream::encode_all(body[0].as_bytes(), 3).expect("frame");
        for chunk in &body[1..] {
            bytes.extend(zstd::stream::encode_all(chunk.as_bytes(), 3).expect("frame"));
        }
        write(&log, &bytes);

        let report = usage_events_at(&[root], None, &mut Default::default());
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert_eq!(report.events.len(), 2, "{:?}", report.events);
        assert_eq!(report.events[0].at_ms, 1_791_083_553_999);
        assert_eq!(report.events[0].tokens.total(), 9_659);
        assert_eq!(report.events[0].tokens.cache_read, 9_088);
        assert_eq!(report.events[0].tokens.input, 306);
        assert_eq!(report.events[0].model.as_deref(), Some("deepseek-flash"));
        assert_eq!(report.events[0].provider.as_deref(), Some("deepseek-account"));
        assert_eq!(report.events[1].tokens.total(), 26_439);
        drop(dir);
    }

    /// Compaction is a model call of its own: dsh logs its tokens on a `compaction/summary` record
    /// that carries no routing, and leaving those out loses real usage (on this machine 12 of them,
    /// 2,783,515 tokens - 0.18% of the store, and the reason the first version of this reader was
    /// short by exactly that).
    #[test]
    fn a_compaction_is_counted_and_takes_the_sessions_selected_model() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("sessions");
        let log = root
            .join("--F-proj--")
            .join("session-1")
            .join("session.jsonl.zstd");
        let body = [
            r#"{"type":"model/selection","seq":1,"time":1791083500789,"data":{"provider":"deepseek-account","model":"deepseek-flash"}}"#.to_string(),
            r#"{"type":"compaction/summary","seq":2,"time":1791083600000,"data":{"llmStreamCall":true,"usage":{"inputTokens":575,"outputTokens":4003,"cacheReadTokens":216576,"cacheWriteTokens":0,"totalTokens":221154}}}"#.to_string(),
        ]
        .join("\n")
            + "\n";
        write(&log, &two_frames(&body, ""));
        let report = usage_events_at(&[root], None, &mut Default::default());
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert_eq!(report.events.len(), 1, "{:?}", report.events);
        assert_eq!(report.events[0].tokens.total(), 221_154);
        assert_eq!(report.events[0].tokens.cache_read, 216_576);
        assert_eq!(report.events[0].model.as_deref(), Some("deepseek-flash"));
        assert_eq!(report.events[0].provider.as_deref(), Some("deepseek-account"));
        drop(dir);
    }

    #[test]
    fn the_numbered_log_is_the_one_read_when_a_stale_copy_sits_beside_it() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("sessions");
        let session = root.join("--F-proj--").join("session-1");
        write(
            &session.join("session.jsonl.zstd"),
            &two_frames(&format!("{}\n", answer(1, 1_791_083_553_999, 100, 0, 0)), ""),
        );
        write(
            &session.join("session.v4.jsonl.zstd"),
            &two_frames(&format!("{}\n", answer(1, 1_791_083_553_999, 7, 0, 0)), ""),
        );
        write(&session.join("session.meta.json"), b"{}");

        let report = usage_events_at(&[root], None, &mut Default::default());
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert_eq!(report.events.len(), 1, "the stale copy is not read too");
        assert_eq!(report.events[0].tokens.total(), 7);
        drop(dir);
    }

    #[test]
    fn an_inherited_prefix_belongs_to_the_session_it_was_forked_from() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("sessions");
        let log = root.join("--F-proj--").join("session-2").join("session.v4.jsonl.zstd");
        let bytes = two_frames(
            &([
                r#"{"type":"session","seq":1,"time":1791083494686,"isSeeded":true}"#.to_string(),
                answer(2, 1_791_083_553_999, 500, 0, 0),
                r#"{"type":"session/end-seed","seq":3,"time":1791083560000,"data":{"inherited":true}}"#
                    .to_string(),
            ]
            .join("\n")
                + "\n"),
            &format!("{}\n", answer(4, 1_791_083_600_000, 9, 0, 0)),
        );
        write(&log, &bytes);

        let report = usage_events_at(&[root], None, &mut Default::default());
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert_eq!(report.events.len(), 1, "{:?}", report.events);
        assert_eq!(report.events[0].tokens.total(), 9);
        drop(dir);
    }

    #[test]
    fn a_range_start_keeps_only_what_is_inside_it() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("sessions");
        let log = root.join("--F-proj--").join("session-1").join("session.jsonl.zstd");
        write(
            &log,
            &two_frames(
                &format!("{}\n", answer(1, 1_791_083_553_999, 10, 0, 0)),
                &format!("{}\n", answer(2, 1_791_083_600_000, 20, 0, 0)),
            ),
        );
        let report = usage_events_at(&[root], Some(1_791_083_600_000), &mut Default::default());
        assert_eq!(report.events.len(), 1, "{:?}", report.events);
        assert_eq!(report.events[0].tokens.total(), 20);
        drop(dir);
    }

    #[test]
    fn a_store_that_is_not_there_has_no_events_and_nothing_to_report() {
        let dir = tempfile::tempdir().expect("temp dir");
        let report = usage_events_at(&[dir.path().join("nope")], None, &mut Default::default());
        assert!(report.events.is_empty());
        assert!(report.failures.is_empty());
    }

    #[test]
    fn only_session_log_names_are_logs() {
        assert_eq!(log_version(Path::new("/a/session.jsonl.zstd")), Some(0));
        assert_eq!(log_version(Path::new("/a/session.jsonl")), Some(0));
        assert_eq!(log_version(Path::new("/a/session.v4.jsonl.zstd")), Some(4));
        assert_eq!(log_version(Path::new("/a/session.v12.jsonl")), Some(12));
        assert_eq!(log_version(Path::new("/a/session.meta.json")), None);
        assert_eq!(log_version(Path::new("/a/session.v.jsonl")), None);
        assert_eq!(log_version(Path::new("/a/other.v4.jsonl.zstd")), None);
    }
}
