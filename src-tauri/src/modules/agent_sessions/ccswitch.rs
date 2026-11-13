//! A second-hand ledger: cc-switch's daily rollup of what these agents spent.
//!
//! cc-switch keeps `~/.cc-switch/cc-switch.db`, whose `usage_daily_rollups` table holds one row per
//! day, agent, provider and model - the same four dimensions this module's report already uses. It
//! is read here for the one thing it can offer on its own: **days the direct readers have no events
//! for**. Claude Code is why: this machine's `~/.claude/projects` holds three recent sessions, while
//! the rollup keeps 78 days between 2026-04-06 and 2026-08-30 whose transcripts are gone. Those days
//! would otherwise be a hole in the history rather than old usage.
//!
//! A day the direct read covers is left alone. The rollup is built from the same transcripts (its
//! `provider_id` is `_session` for all of the local ones), so importing a covered day would count
//! those tokens twice, and no arithmetic on two daily totals can tell which part overlaps. A day is
//! therefore filled whole or not filled at all.
//!
//! `input_token_semantics` marks how a row's `input_tokens` relates to the cache. Every row here is
//! on the same footing as the direct readers - input excludes the cached prompt (a real row: 122,342
//! input beside 7,638,348 cache reads) - so nothing is moved between classes, and a tool whose
//! accounting *did* include the cache would have to be reclassified before it reached this table,
//! which is not something this reader can tell from a row.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::usage::{OwnedUsageEvent, UsageReadReport, UsageTokens};

/// The agents this reader is willing to attribute rows to.
///
/// Anything else in the table is left out: the rollup also covers `codex`, which is not an agent this
/// app reads, and inventing a seventh tool from a foreign ledger would be worse than not showing it.
const TOOLS: [&str; 6] = ["claude", "pi", "opencode", "zcode", "workbuddy", "dsh"];

/// cc-switch's own store, beside its settings.
pub(crate) fn default_db_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".cc-switch/cc-switch.db"))
}

/// The days this ledger can add, oldest first.
///
/// `covered` is every `(tool, day)` the direct readers already answered for; a row whose day is in
/// it is skipped. `offset_minutes` is the caller's time zone, used to place a day at its own local
/// midnight - the rollup names a date, and a date means nothing until a zone turns it into an instant.
pub(crate) fn usage_events_at(
    path: &Path,
    since_ms: Option<i64>,
    offset_minutes: i32,
    covered: &HashSet<(&'static str, i64)>,
) -> UsageReadReport {
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
    let mut statement = match conn.prepare(
        "select date, app_type, provider_id, model, input_tokens, output_tokens,
                cache_read_tokens, cache_creation_tokens
           from usage_daily_rollups",
    ) {
        Ok(statement) => statement,
        Err(error) => {
            // A store without the table is an older cc-switch: nothing to add, nothing to report.
            if !error.to_string().contains("no such table") {
                report
                    .failures
                    .push(format!("无法查询 cc-switch 用量汇总：{error}"));
            }
            return report;
        }
    };
    let rows = match statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, i64>(7)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(error) => {
            report
                .failures
                .push(format!("无法读取 cc-switch 用量汇总：{error}"));
            return report;
        }
    };
    for row in rows {
        let Ok((date, app_type, provider_id, model, input, output, cache_read, cache_write)) = row
        else {
            continue;
        };
        let Some(tool) = TOOLS.into_iter().find(|tool| *tool == app_type) else {
            continue;
        };
        let Some(day) = super::usage::day_from_label(&date) else {
            continue;
        };
        if covered.contains(&(tool, day)) {
            continue;
        }
        let at_ms = day
            .saturating_mul(86_400_000)
            .saturating_sub(i64::from(offset_minutes) * 60_000);
        if since_ms.is_some_and(|since| at_ms < since) {
            continue;
        }
        let tokens = UsageTokens {
            input: as_count(input),
            output: as_count(output),
            cache_read: as_count(cache_read),
            cache_write: as_count(cache_write),
            ..UsageTokens::ZERO
        };
        if tokens.total() == 0 {
            continue;
        }
        report.events.push(OwnedUsageEvent {
            at_ms,
            tool,
            provider: readable_provider(&provider_id),
            model: Some(model).filter(|model| !model.is_empty()),
            tokens,
        });
    }
    report.events.sort_by_key(|event| event.at_ms);
    report
}

fn as_count(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

/// The provider name a model row can show, if the rollup's id is a name at all.
///
/// Most rows carry a provider record's UUID (`795e0f7e-5752-41f5-b0cb-2d10164999a4`) or cc-switch's
/// own marker for "read from the session logs" (`_session`); neither is a provider a reader of this
/// window could make sense of, and printing one under every model would be noise.
fn readable_provider(provider_id: &str) -> Option<String> {
    if provider_id.is_empty() || provider_id.starts_with('_') || looks_like_uuid(provider_id) {
        return None;
    }
    Some(provider_id.to_string())
}

fn looks_like_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn temp_db() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("cc-switch.db");
        let conn = Connection::open(&path).expect("open");
        conn.execute_batch(
            "CREATE TABLE usage_daily_rollups (
                date TEXT NOT NULL,
                app_type TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                model TEXT NOT NULL,
                request_model TEXT NOT NULL DEFAULT '',
                pricing_model TEXT NOT NULL DEFAULT '',
                request_count INTEGER NOT NULL DEFAULT 0,
                success_count INTEGER NOT NULL DEFAULT 0,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                total_cost_usd TEXT NOT NULL DEFAULT '0',
                avg_latency_ms INTEGER NOT NULL DEFAULT 0,
                input_token_semantics INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (date, app_type, provider_id, model, request_model, pricing_model)
            );",
        )
        .expect("schema");
        (dir, path)
    }

    fn insert(
        path: &Path,
        date: &str,
        app_type: &str,
        provider: &str,
        model: &str,
        tokens: (i64, i64, i64, i64),
    ) {
        let conn = Connection::open(path).expect("open");
        conn.execute(
            "INSERT INTO usage_daily_rollups
                (date, app_type, provider_id, model, request_count, input_tokens, output_tokens,
                 cache_read_tokens, cache_creation_tokens)
             VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8)",
            rusqlite::params![date, app_type, provider, model, tokens.0, tokens.1, tokens.2, tokens.3],
        )
        .expect("insert");
    }

    #[test]
    fn a_day_the_direct_read_has_nothing_for_is_filled_whole() {
        let (dir, path) = temp_db();
        insert(
            &path,
            "2026-08-30",
            "claude",
            "795e0f7e-5752-41f5-b0cb-2d10164999a4",
            "gpt-5.6-terra",
            (337_325, 4_721, 833_802, 0),
        );
        let report = usage_events_at(&path, None, 480, &HashSet::new());
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert_eq!(report.events.len(), 1, "{:?}", report.events);
        let event = &report.events[0];
        assert_eq!(event.tool, "claude");
        // Local midnight in UTC+8, which is the instant `day_of` puts back in that day.
        assert_eq!(super::super::usage::day_of(event.at_ms, 480), super::super::usage::day_from_label("2026-08-30").unwrap());
        assert_eq!(event.tokens.total(), 1_175_848);
        assert_eq!(event.tokens.cache_read, 833_802);
        assert_eq!(event.model.as_deref(), Some("gpt-5.6-terra"));
        // A provider record's id is not a name: nothing is shown under the model.
        assert_eq!(event.provider, None);
        drop(dir);
    }

    #[test]
    fn a_day_the_direct_read_covers_is_left_to_it() {
        let (dir, path) = temp_db();
        insert(&path, "2026-08-30", "claude", "_session", "m", (100, 0, 0, 0));
        let day = super::super::usage::day_from_label("2026-08-30").unwrap();
        let covered: HashSet<(&'static str, i64)> = HashSet::from([("claude", day)]);
        let report = usage_events_at(&path, None, 480, &covered);
        assert!(report.events.is_empty(), "{:?}", report.events);
        // The same day is filled for a tool nothing has covered.
        let report = usage_events_at(&path, None, 480, &HashSet::new());
        assert_eq!(report.events.len(), 1);
        drop(dir);
    }

    #[test]
    fn only_agents_this_app_reads_are_taken_and_empty_rows_are_dropped() {
        let (dir, path) = temp_db();
        insert(&path, "2026-08-30", "codex", "_session", "gpt-6", (1_000, 100, 0, 0));
        insert(&path, "2026-08-30", "opencode", "_opencode_session", "glm-5.3-flash", (10, 1, 2, 0));
        insert(&path, "2026-08-30", "claude", "some-provider", "m", (0, 0, 0, 0));
        let report = usage_events_at(&path, None, 480, &HashSet::new());
        assert_eq!(report.events.len(), 1, "{:?}", report.events);
        assert_eq!(report.events[0].tool, "opencode");
        assert_eq!(report.events[0].provider, None);
        drop(dir);
    }

    #[test]
    fn a_range_start_before_the_day_keeps_it() {
        let (dir, path) = temp_db();
        insert(&path, "2026-08-30", "claude", "_session", "m", (100, 0, 0, 0));
        let midnight = super::super::usage::day_from_label("2026-08-30").unwrap() * 86_400_000 - 480 * 60_000;
        assert_eq!(usage_events_at(&path, Some(midnight), 480, &HashSet::new()).events.len(), 1);
        assert_eq!(usage_events_at(&path, Some(midnight + 1), 480, &HashSet::new()).events.len(), 0);
        drop(dir);
    }

    #[test]
    fn a_store_that_is_not_there_has_no_events_and_nothing_to_report() {
        let dir = tempfile::tempdir().expect("temp dir");
        let report = usage_events_at(&dir.path().join("nope.db"), None, 0, &HashSet::new());
        assert!(report.events.is_empty());
        assert!(report.failures.is_empty());
    }

    #[test]
    fn a_store_without_the_table_is_an_older_cc_switch_not_a_failure() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("cc-switch.db");
        Connection::open(&path).expect("open");
        let report = usage_events_at(&path, None, 0, &HashSet::new());
        assert!(report.events.is_empty());
        assert!(report.failures.is_empty(), "{:?}", report.failures);
    }

    #[test]
    fn only_hex_and_dashes_in_the_uuid_shape_are_treated_as_ids() {
        assert!(looks_like_uuid("795e0f7e-5752-41f5-b0cb-2d10164999a4"));
        assert!(!looks_like_uuid("_session"));
        assert!(!looks_like_uuid("some-provider"));
        assert_eq!(readable_provider("_session"), None);
        assert_eq!(
            readable_provider("bigmodel-start-plan").as_deref(),
            Some("bigmodel-start-plan")
        );
    }
}
