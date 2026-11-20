//! workbuddy's usage: one JSONL page per project, `~/.workbuddy/projects/<project>/<session>.jsonl`.
//!
//! Only usage is read here. workbuddy also keeps a `workbuddy.db` beside this directory, but its
//! `session_usage` table holds the account's credit meter (`used`, `size`, `credit_json`), not the
//! per-answer count, so the transcripts are the only honest source for "how much was used when".

use std::path::{Path, PathBuf};

use super::usage::{OwnedUsageEvent, UsageReadReport};

pub(crate) const TOOL: &str = "workbuddy";

/// Every directory workbuddy keeps project transcripts in.
///
/// 5.5 moved both the sessions and the database to `.workbuddy-ai`, so both spellings are read when
/// they exist; only the directories that exist are returned.
pub(crate) fn usage_roots() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    [".workbuddy/projects", ".workbuddy-ai/projects"]
        .into_iter()
        .map(|name| home.join(name))
        .filter(|path| path.is_dir())
        .collect()
}

/// Every usage event in this store, oldest first.
///
/// Two levels deep: `<project>/<session>.jsonl`. The directory also holds caches and logs at other
/// depths (18,000+ files in `~/.workbuddy`), so the walk stops at the session file instead of
/// scanning the tree. `since_ms` skips what a range leaves out.
pub(crate) fn usage_events_at(
    roots: &[PathBuf],
    since_ms: Option<i64>,
    cache: &mut super::usage_cache::UsageFileCache,
) -> UsageReadReport {
    let mut files = Vec::new();
    for root in roots {
        walk_jsonl(root, 3, &mut files);
    }
    cache.read_jsonl(TOOL, &files, since_ms, |line| {
        // Most lines carry no usage at all (reasoning, tool calls, snapshots), and the usage key is
        // cheap to look for: parsing only the lines that can be an answer keeps a 42 MB project
        // history quick.
        if !line.contains("\"usage\"") {
            return None;
        }
        let value = serde_json::from_str::<serde_json::Value>(line.trim_end()).ok()?;
        let usage = super::usage::workbuddy_usage_of_line(&value)?;
        Some(super::usage_cache::FileEvent {
            key: None,
            event: OwnedUsageEvent {
                at_ms: value
                    .get("timestamp")
                    .and_then(serde_json::Value::as_i64)?,
                tool: TOOL,
                provider: usage.provider,
                model: usage.model,
                tokens: usage.tokens,
            },
        })
    })
}

/// Every `.jsonl` under `dir`, `depth` directories deep.
fn walk_jsonl(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_dir() {
            if depth > 0 {
                walk_jsonl(&path, depth - 1, out);
            }
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(path, body).expect("write");
    }

    #[test]
    fn project_transcripts_become_usage_events_two_levels_deep() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("projects");
        write(
            &root.join("proj-a").join("s1.jsonl"),
            &[
                r#"{"type":"session-meta","timestamp":1792588000000}"#,
                r#"{"type":"function_call","timestamp":1792588393537,"providerData":{"requestModelId":"hy3","usage":{"inputTokens":43847,"outputTokens":926,"totalTokens":44773,"inputTokensDetails":[{"cached_tokens":6528}]}}}"#,
            ]
            .join("\n"),
        );
        write(
            &root.join("proj-a").join("nested").join("s2.jsonl"),
            r#"{"type":"function_call","timestamp":1792588400000,"providerData":{"requestModelId":"hy3","usage":{"inputTokens":100,"outputTokens":10,"totalTokens":110}}}"#,
        );

        let report = usage_events_at(&[root], None, &mut Default::default());
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert_eq!(report.events.len(), 2, "{:?}", report.events);
        assert_eq!(report.events[0].tokens.total(), 44_773);
        assert_eq!(report.events[0].tokens.cache_read, 6_528);
        assert_eq!(report.events[1].tokens.total(), 110);
        assert_eq!(report.events[0].model.as_deref(), Some("hy3"));
        drop(dir);
    }

    #[test]
    fn a_store_that_is_not_there_has_no_events_and_nothing_to_report() {
        let dir = tempfile::tempdir().expect("temp dir");
        let report = usage_events_at(&[dir.path().join("nope")], None, &mut Default::default());
        assert!(report.events.is_empty());
        assert!(report.failures.is_empty());
    }
}
