//! zcode's usage, from its own database (`~/.zcode/cli/db/db.sqlite`).
//!
//! zcode is an IDE agent: only usage is read here - no session list, no delete, no rename. Its
//! `message` table keeps opencode's old shape (role, model and tokens inside the row's JSON), and
//! its `model_usage` / `turn_usage` tables are a per-request ledger that only starts part-way
//! through this machine's history (2026-10-04, against transcripts from 2026-09-16), so the
//! transcripts are what this reads: they are the complete record, and they agree exactly with the
//! step parts beside them (4,395,371,840 tokens either way, measured 2026-11-13).

use std::path::{Path, PathBuf};

use super::usage::{OwnedUsageEvent, UsageReadReport};

pub(crate) const TOOL: &str = "zcode";

/// zcode keeps everything in one database under its own home directory.
pub(crate) fn default_db_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".zcode/cli/db/db.sqlite"))
}

/// Every usage event in this store, oldest first.
///
/// A store without a `message` table is an older zcode: no events, and nothing to report about it.
/// A store that cannot be opened or queried is a failure, not an empty window.
pub(crate) fn usage_events_at(path: &Path, since_ms: Option<i64>) -> UsageReadReport {
    let mut report = UsageReadReport::default();
    if !path.is_file() {
        return report;
    }
    let conn = match super::opencode::open_read_only(path) {
        Ok(conn) => conn,
        Err(error) => {
            report.failures.push(error);
            return report;
        }
    };
    // The role and the tokens live inside the row's JSON, so both filters are `json_extract` with a
    // `json_valid` guard in a `CASE` (SQLite does not promise `AND` term order, and one malformed
    // row would otherwise fail the whole query).
    let mut statement = match conn.prepare(
        r"select time_created, data
          from message
          where (?1 is null or time_created >= ?1)
            and case when json_valid(data) then json_extract(data, '$.role') end = 'assistant'
            and case when json_valid(data) then json_extract(data, '$.tokens') end is not null",
    ) {
        Ok(statement) => statement,
        Err(error) => {
            if !error.to_string().contains("no such table") {
                report.failures.push(format!("无法查询 zcode 消息：{error}"));
            }
            return report;
        }
    };
    let rows = match statement.query_map(rusqlite::params![since_ms], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?))
    }) {
        Ok(rows) => rows,
        Err(error) => {
            report.failures.push(format!("无法读取 zcode 消息：{error}"));
            return report;
        }
    };
    for row in rows {
        let Ok((at_ms, Some(data))) = row else {
            continue;
        };
        let Ok(data) = serde_json::from_str::<serde_json::Value>(&data) else {
            continue;
        };
        let Some(usage) = super::usage::zcode_usage_of_message(&data) else {
            continue;
        };
        report.events.push(OwnedUsageEvent {
            at_ms,
            tool: TOOL,
            provider: usage.provider,
            model: usage.model,
            tokens: usage.tokens,
        });
    }
    report.events.sort_by_key(|event| event.at_ms);
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn temp_db() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("db.sqlite");
        let conn = Connection::open(&path).expect("open");
        conn.execute_batch(
            "CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT
            );",
        )
        .expect("schema");
        (dir, path)
    }

    fn insert(path: &Path, id: &str, at: i64, data: &str) {
        let conn = Connection::open(path).expect("open");
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, time_updated, data)              VALUES (?1, 'ses_1', ?2, ?2, ?3)",
            rusqlite::params![id, at, data],
        )
        .expect("insert");
    }

    #[test]
    fn message_rows_become_usage_events_with_their_model() {
        let (dir, path) = temp_db();
        insert(
            &path,
            "m1",
            1_794_500_000_000,
            r#"{"role":"assistant","modelId":"GLM-5.3-Flash","providerId":"account:bigmodel","tokens":{"total":480937,"input":477824,"output":3113,"cache":{"read":477056,"write":0}}}"#,
        );
        insert(&path, "m2", 1_794_500_100_000, r#"{"role":"user","content":"hi"}"#);
        insert(
            &path,
            "m3",
            1_794_600_000_000,
            r#"{"role":"assistant","modelId":"GLM-5.3-Flash","providerId":"account:bigmodel","tokens":{"total":100,"input":90,"output":10,"cache":{"read":0,"write":0}}}"#,
        );

        let report = usage_events_at(&path, None);
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert_eq!(report.events.len(), 2, "the user row is not an event");
        assert_eq!(report.events[0].at_ms, 1_794_500_000_000);
        assert_eq!(report.events[0].tokens.total(), 480_937);
        assert_eq!(report.events[0].model.as_deref(), Some("GLM-5.3-Flash"));

        // The same read with a range start keeps only what is inside it.
        let ranged = usage_events_at(&path, Some(1_794_600_000_000));
        assert_eq!(ranged.events.len(), 1);
        assert_eq!(ranged.events[0].tokens.total(), 100);
        drop(dir);
    }

    #[test]
    fn a_store_without_the_table_is_an_older_zcode_not_a_failure() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("db.sqlite");
        Connection::open(&path).expect("open");
        let report = usage_events_at(&path, None);
        assert!(report.events.is_empty());
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        drop(dir);
    }
}
