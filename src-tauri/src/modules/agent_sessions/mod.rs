pub mod types;

mod archive;
mod claude;
mod delete;
mod dsh;
mod image;
mod opencode;
mod pi;
mod workbuddy;
mod zcode;
mod service_turns;
pub mod stats;
pub mod usage;
pub mod watch;
mod wsl;

use delete::{DeleteReport, SessionTarget};
use tauri::Manager;
use types::AgentSessionsPayload;

/// Which sessions the opencode service says it is running right now.
///
/// `None` when the service could not be asked at all - which is the normal case for an opencode
/// that is not running - and the caller then keeps the write times it already has. An empty list is
/// a real answer: the service is up and nothing is running.
///
/// The answer is complete rather than a page: the endpoint it reads documents that "sessions absent
/// from the result are inactive", so a session missing from it can be settled from it.
///
/// This hits the network, so it runs off the main thread: a service that is stopping can hold the
/// connection for the whole timeout.
#[tauri::command]
pub async fn agent_sessions_running(
    distro: Option<String>,
) -> Result<Option<Vec<String>>, String> {
    // The inner value is already an `Option`: `None` means "could not ask", which the caller
    // treats differently from an empty list. A failure of the blocking pool itself reads the same
    // as "could not ask", so it is flattened rather than surfaced as an error the list would show.
    let asked = crate::modules::fs::blocking(move || match distro {
        None => match dirs::home_dir() {
            // `running_ids` does the HTTP read itself; the blocking pool is where a network call
            // that may sit until its timeout belongs, so it is driven to completion here.
            Some(home) => Ok(tauri::async_runtime::block_on(service_turns::running_ids(
                &service_turns::service_file_under(&home),
            ))),
            None => Ok(None),
        },
        Some(distro) => Ok(wsl::running_ids(&distro)),
    })
    .await;
    Ok(asked.ok().flatten())
}

/// Reads sqlite and session files, so it runs on the blocking pool: Tauri runs a
/// non-async command inline in the IPC handler (the main thread on macOS).
///
/// `distro` picks whose store to read: `None` is this machine, `Some(name)` is
/// that WSL distro's, which is read by running the query inside it.
#[tauri::command]
pub async fn agent_sessions_list(
    tool: String,
    distro: Option<String>,
) -> Result<AgentSessionsPayload, String> {
    let listed = crate::modules::fs::blocking(move || match (tool.as_str(), distro.as_deref()) {
        (opencode::TOOL, Some(distro)) => wsl::list(distro),
        (opencode::TOOL, None) => opencode::list(),
        (pi::TOOL, Some(distro)) => Ok(wsl::pi_is_absent(distro)),
        (pi::TOOL, None) => pi::list(),
        // Claude Code writes `~/.claude/projects` on whichever side it runs, so a distro's own store
        // is read through the share of its filesystem (`wsl::claude_list`). Answering with the local
        // list instead would show every session once per distro.
        (claude::TOOL, Some(distro)) => wsl::claude_list(distro),
        (claude::TOOL, None) => claude::list(),
        (other, _) => Err(format!("不支持的会话工具：{other}")),
    })
    .await?;
    Ok(one_row_per_session(listed))
}

/// One row per session id.
///
/// A session id identifies a session, and two rows carrying the same one are not two sessions: the
/// list cannot tell them apart, the manage view offers to delete "it" twice, and the page keys its
/// rows by id - so a repeat makes React reconcile two rows onto one key, which is how stale rows were
/// left behind after leaving the manage view (measured: 14 extra rows per round trip).
///
/// This happens for real: Claude Code files a session's subagent directory under the project key of
/// *every* directory that session was used in, keeping the same `agent-*.jsonl` files under each. On
/// this machine one session has 22 transcripts under one key and 14 under another, 14 ids in common.
///
/// The newest copy wins. Each tool returns its rows newest first, so the first of a group is the one
/// whose file (and `.meta.json`) was written last - the copy with the name on it.
fn one_row_per_session(payload: AgentSessionsPayload) -> AgentSessionsPayload {
    let mut seen = std::collections::HashSet::new();
    let mut sessions = Vec::with_capacity(payload.sessions.len());
    for session in payload.sessions {
        if seen.insert(session.id.clone()) {
            sessions.push(session);
        }
    }
    AgentSessionsPayload {
        sessions,
        warnings: payload.warnings,
    }
}

/// Deleting touches sqlite, the filesystem and a child process, so it runs on
/// the blocking pool too.
#[tauri::command]
pub async fn agent_sessions_delete(targets: Vec<SessionTarget>) -> DeleteReport {
    crate::modules::fs::blocking(move || Ok(delete::delete_sessions(&targets)))
        .await
        .unwrap_or_default()
}

/// Every usage event this machine's tools can offer, oldest first.
///
/// The seam a usage window and an export read. Each tool is read independently and its failures are
/// collected rather than raised: one store that cannot be read must not hide the others' numbers
/// (the same rule the session list follows), and a tool whose store is simply not there contributes
/// nothing without saying anything about it.
///
/// `since_ms` is the oldest instant worth reading - a window's range start. It is pushed into each
/// reader, so a range query does not pay for years of history.
///
/// WSL distributions are not read here: their opencode store needs the in-distro query (`wsl`), and
/// the two JSONL stores have no distro reader at all. A window that means to include them cannot
/// pretend they are covered, so this says so in one place instead of silently leaving them out.
///
/// The window's time zone does not enter here: every reader writes an instant, and the day a token
/// belongs to is decided once, when the report is summed.
pub fn usage_events(since_ms: Option<i64>) -> UsageRead {
    // The single-path stores are bound first: `as_deref` would otherwise borrow a temporary that the
    // struct literal drops before it is read.
    let pi_root = pi::default_root();
    let opencode_db = opencode::default_db_path();
    let zcode_db = zcode::default_db_path();
    let stores = UsageStores {
        claude: &claude::usage_roots(),
        pi: pi_root.as_deref(),
        opencode: opencode_db.as_deref(),
        zcode: zcode_db.as_deref(),
        workbuddy: &workbuddy::usage_roots(),
        dsh: &dsh::usage_roots(),
    };
    UsageRead {
        available: available_tools(&stores),
        report: usage_events_at(stores, since_ms),
    }
}

/// What one read produced.
pub struct UsageRead {
    pub report: usage::UsageReadReport,
    /// The agents this machine actually has a store for, in the window's order.
    pub available: Vec<&'static str>,
}

/// Which agents are installed, judged by whether their store is there at all.
///
/// The window draws a mark for every agent it knows and greys out the ones that are not here: an
/// agent that is not installed has nothing to filter to, and offering the filter anyway makes the
/// window look broken rather than empty. This is deliberately *not* "has usage": an installed agent
/// with nothing in the range is a normal thing to click, and the report already says the range is
/// empty (see the rule that a missing store and an empty session list are not errors).
pub fn available_tools(stores: &UsageStores<'_>) -> Vec<&'static str> {
    let mut available = Vec::new();
    if stores.claude.iter().any(|root| root.is_dir()) {
        available.push(claude::TOOL);
    }
    if stores.pi.is_some_and(|path| path.is_dir()) {
        available.push(pi::TOOL);
    }
    if stores.opencode.is_some_and(|path| path.is_file()) {
        available.push(opencode::TOOL);
    }
    if stores.zcode.is_some_and(|path| path.is_file()) {
        available.push(zcode::TOOL);
    }
    if stores.workbuddy.iter().any(|root| root.is_dir()) {
        available.push(workbuddy::TOOL);
    }
    if stores.dsh.iter().any(|root| root.is_dir()) {
        available.push(dsh::TOOL);
    }
    available
}

/// The stores a usage read draws on, each optional.
///
/// A struct rather than a list of arguments because the set keeps growing (three when this was
/// written, five now) and positional `Option<&Path>` parameters become unreadable long before that.
/// A store passed as `None` is skipped, which is what an agent that is not installed looks like.
#[derive(Debug, Clone, Copy, Default)]
pub struct UsageStores<'a> {
    /// Claude Code's transcript directories: `projects/` and `transcripts/`, under
    /// `CLAUDE_CONFIG_DIR` when that is set.
    pub claude: &'a [std::path::PathBuf],
    pub pi: Option<&'a std::path::Path>,
    /// opencode, and only opencode: its forks keep their own directories and are read by their own
    /// readers.
    pub opencode: Option<&'a std::path::Path>,
    /// zcode, an IDE agent: usage only, from its own database.
    pub zcode: Option<&'a std::path::Path>,
    /// workbuddy, an IDE agent: usage only, from its project transcripts (two roots exist in the
    /// wild, `.workbuddy` and `.workbuddy-ai`).
    pub workbuddy: &'a [std::path::PathBuf],
    /// dsh's session logs: usage only, one zstd-compressed log per session.
    pub dsh: &'a [std::path::PathBuf],
}

/// The same, with the stores handed in.
pub fn usage_events_at(stores: UsageStores<'_>, since_ms: Option<i64>) -> usage::UsageReadReport {
    let mut report = usage::UsageReadReport::default();
    if !stores.claude.is_empty() {
        merge_usage(&mut report, claude::usage_events_at(stores.claude, since_ms));
    }
    if let Some(root) = stores.pi {
        merge_usage(&mut report, pi::usage_events_at(root, since_ms));
    }
    if let Some(path) = stores.opencode {
        merge_usage(&mut report, opencode::usage_events_at(path, since_ms));
    }
    if let Some(root) = stores.zcode {
        merge_usage(&mut report, zcode::usage_events_at(root, since_ms));
    }
    if !stores.workbuddy.is_empty() {
        merge_usage(
            &mut report,
            workbuddy::usage_events_at(stores.workbuddy, since_ms),
        );
    }
    if !stores.dsh.is_empty() {
        merge_usage(&mut report, dsh::usage_events_at(stores.dsh, since_ms));
    }
    // One order for the whole machine: the window's day buckets are built from this, and two readers
    // that each sorted their own half would leave the report half-ordered.
    report.events.sort_by_key(|event| event.at_ms);
    report
}

fn merge_usage(into: &mut usage::UsageReadReport, mut other: usage::UsageReadReport) {
    into.events.append(&mut other.events);
    into.failures.append(&mut other.failures);
}

/// One tool/provider/model cell of one day: the finest split the window draws with.
///
/// `parts` is what a window switches the cache accounting with, `tokens` is the same cell counted
/// under the scope the caller asked for. One read then answers every view: the trend chart stacks
/// cells inside a day, the heatmap sums a day, the two tables sum over the days in the range, and
/// the composition bar sums the parts. Changing the range or ticking a cache switch is arithmetic on
/// what is already here, not another scan of 5.6 GB of opencode plus every transcript.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCellRow {
    pub tool: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub parts: usage::UsageTokens,
    pub tokens: u64,
    pub events: u32,
}

/// One day, with its cells.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDayRow {
    /// Days since 1970-01-01 in the caller's offset.
    pub day: i64,
    /// `YYYY-MM-DD`, so a window never has to do date arithmetic of its own.
    pub label: String,
    /// The sum of the cells, computed in one place so a day and its bars cannot disagree.
    pub parts: usage::UsageTokens,
    pub tokens: u64,
    pub events: u32,
    /// Biggest first, as `aggregate` ordered them.
    pub cells: Vec<UsageCellRow>,
}

/// What a usage window draws.
///
/// The counts are computed here, so the accounting rule (`TokenScope`) has one reference
/// implementation; the raw `parts` ride along so the window can apply a different scope without
/// reading the stores again.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsagePayload {
    /// The range that was read, echoed back so a slow answer cannot be shown as a fresh one.
    pub since_ms: Option<i64>,
    pub offset_minutes: i32,
    pub scope: usage::TokenScope,
    pub parts: usage::UsageTokens,
    pub tokens: u64,
    pub events: u32,
    /// Cache tokens the scope left out, so the window can say what it is not counting instead of
    /// looking like a different total for no reason.
    pub excluded_cache_read: u64,
    pub excluded_cache_write: u64,
    /// Oldest first, one row per day that had any event.
    pub days: Vec<UsageDayRow>,
    /// Stores that could not be read. A window shows them; they are not an empty result.
    pub failures: Vec<String>,
    /// The agents this machine has a store for: the window greys out the rest.
    pub available_tools: Vec<&'static str>,
}

/// One writer to the usage archive at a time.
///
/// `agent_usage_events` runs on the blocking pool, so a second ask - a double-click on the window's
/// refresh, or a probe calling beside it - can be in the same read-merge-write while the first is still
/// holding the file it read.
static ARCHIVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Usage over a range, per day, broken down by tool and model inside each day.
///
/// The read is the expensive part (this machine: a 5.6 GB opencode database plus tens of megabytes
/// of transcripts), so it runs on the blocking pool and `since_ms` is pushed into it. The window
/// asks for everything once and slices locally, which is why `since_ms` is usually `None` from it:
/// the ranges it offers (today / this week / this month / all) are then a sum over `days` instead of
/// a fresh scan each.
#[tauri::command]
pub async fn agent_usage_events(
    app: tauri::AppHandle,
    since_ms: Option<i64>,
    offset_minutes: Option<i32>,
    cache_read: Option<bool>,
    cache_write: Option<bool>,
) -> Result<UsagePayload, String> {
    let offset = offset_minutes.unwrap_or(0);
    let scope = usage::TokenScope {
        cache_read: cache_read.unwrap_or(true),
        cache_write: cache_write.unwrap_or(true),
    };
    crate::modules::fs::blocking(move || {
        let UsageRead { report, available } = usage_events(since_ms);
        let folded = report.aggregate(offset);
        let mut days = folded.days;
        let mut failures = report.failures;
        // What this machine has already been billed for goes with what it can read now: a session that
        // was deleted is still usage, and a read that no longer sees it must not erase it
        // (`archive.rs`). The offset is recorded in the file so a later read knows which day boundary
        // these keys were bucketed with.
        match app.path().app_data_dir() {
            Ok(dir) => {
                let path = dir.join(archive::ARCHIVE_FILE);
                // One writer at a time: this runs on the blocking pool, so a second ask can be in the same
                // read-merge-write while the first still holds the file it read. The lock covers the
                // archive only - the scan is the slow part and it writes nothing.
                let _writing = ARCHIVE_LOCK
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                let (mut stored, mut notes) = archive::load(&path);
                stored.offset_minutes = offset;
                // The offset is part of the day's identity: folding another boundary's days in here is
                // what made a time-zone change count the same usage twice.
                stored.merge_days(&days, offset);
                if let Err(why) = stored.save(&path) {
                    notes.push(format!("用量归档写不进去：{why}"));
                }
                failures.append(&mut notes);
                days = stored.days(offset);
            }
            // No data directory is not a reason to fail the read: the window still has the live scan, and
            // the note says why the archive's tokens are missing rather than showing a total that
            // quietly stopped including them.
            Err(why) => failures.push(format!("用量归档没有目录：{why}")),
        }
        Ok(folded_payload(days, since_ms, offset, scope, failures, available))
    })
    .await
}

/// The window's payload, from the days the read and the archive settled on.
///
/// Every number here is summed from `days`, which is the same list the window draws its rows and its
/// chart from: a header counted separately could disagree with them, and the two would come apart
/// exactly when the archive adds a day the live scan no longer has.
fn folded_payload(
    days: Vec<usage::DayUsage>,
    since_ms: Option<i64>,
    offset: i32,
    scope: usage::TokenScope,
    failures: Vec<String>,
    available: Vec<&'static str>,
) -> UsagePayload {
    let mut totals = usage::UsageTotals::default();
    for day in &days {
        totals.tokens += day.totals.tokens;
        totals.events = totals.events.saturating_add(day.totals.events);
    }
    let tokens = totals.counted(scope);
    let excluded_cache_read = if scope.cache_read {
        0
    } else {
        totals.tokens.cache_read
    };
    let excluded_cache_write = if scope.cache_write {
        0
    } else {
        totals.tokens.cache_write
    };
    let days = days
        .iter()
        .map(|day| {
            let cells = day
                .cells
                .iter()
                .map(|cell| UsageCellRow {
                    tool: cell.tool.clone(),
                    provider: cell.provider.clone(),
                    model: cell.model.clone(),
                    parts: cell.totals.tokens,
                    tokens: cell.totals.counted(scope),
                    events: cell.totals.events,
                })
                .collect();
            UsageDayRow {
                day: day.day,
                label: usage::day_label(day.day),
                parts: day.totals.tokens,
                tokens: day.totals.counted(scope),
                events: day.totals.events,
                cells,
            }
        })
        .collect();
    UsagePayload {
        since_ms,
        offset_minutes: offset,
        scope,
        parts: totals.tokens,
        tokens,
        events: totals.events,
        excluded_cache_read,
        excluded_cache_write,
        days,
        failures,
        available_tools: available,
    }
}

/// Rename a session (rename only, no session management).
///
/// Each tool has its own mechanism: opencode updates the `title` column, pi appends a
/// `session_info` line to the session file (which is what its own `/name` does). The name
/// is written only to the session's own storage and no other column is touched, so a
/// rename **never** pushes the session to the top of the list.
#[tauri::command]
pub async fn agent_sessions_rename(
    tool: String,
    id: String,
    name: String,
    distro: Option<String>,
) -> Result<(), String> {
    crate::modules::fs::blocking(move || rename_session(&tool, &id, &name, distro.as_deref())).await
}

fn rename_session(tool: &str, id: &str, name: &str, distro: Option<&str>) -> Result<(), String> {
    if let Some(distro) = distro {
        return Err(format!("WSL 会话的改名尚未实现（{distro}）"));
    }
    delete::validate_session_id(id)?;
    let stores = delete::Stores::default_paths();
    match tool {
        opencode::TOOL => {
            let path = stores
                .opencode
                .ok_or_else(|| "找不到 opencode 数据库的位置".to_string())?;
            opencode::rename_at(&path, id, name)
        }
        pi::TOOL => {
            let root = stores
                .pi
                .ok_or_else(|| "找不到 pi 会话目录的位置".to_string())?;
            pi::rename_at(&root, id, name)
        }
        // Refused rather than approximated: Claude Code's name is a `custom-title` event inside its
        // own ledger, and a line this app appended is not something the tool is known to read back. A
        // name that silently does nothing would be worse than saying it cannot be set here.
        claude::TOOL => Err(
            "Claude Code 的会话名由 Claude Code 自己写，这里改不了（可在它内部用 /rename）".to_string(),
        ),
        other => Err(format!("不支持的会话工具：{other}")),
    }
}

/// Looks up the image a message attached, by the name the terminal printed.
/// It reads sqlite, so it runs on the blocking pool as well.
#[tauri::command]
pub async fn agent_sessions_image(
    name: String,
    directory: Option<String>,
    skip: Option<u32>,
) -> Result<Option<String>, String> {
    let skip = skip.unwrap_or(0) as usize;
    crate::modules::fs::blocking(move || image::data_url_by_name(&name, directory.as_deref(), skip))
        .await
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::agent_sessions::stats::SessionStats;
    use crate::modules::agent_sessions::types::AgentSession;

    fn row(id: &str, parent_id: Option<&str>, updated_at_ms: i64, title: &str) -> AgentSession {
        AgentSession {
            tool: "claude".to_string(),
            id: id.to_string(),
            title: title.to_string(),
            cwd: "C:/x".to_string(),
            updated_at_ms,
            parent_id: parent_id.map(str::to_string),
            stats: SessionStats::default(),
        }
    }

    #[test]
    fn keeps_one_row_per_session_id_and_takes_the_newest() {
        // Real shape: one session's subagents filed under two project keys, 14 ids in common. The copy
        // with the `.meta.json` is the newer one, so its name is the one the row keeps.
        let payload = AgentSessionsPayload {
            sessions: vec![
                row("agent", Some("s1"), 200, "inspect:TraycerAI"),
                row("s1", None, 150, "daily task"),
                row("agent", Some("s1"), 100, "agent"),
            ],
            warnings: vec![],
        };
        let deduped = one_row_per_session(payload);
        assert_eq!(deduped.sessions.len(), 2, "{:?}", deduped.sessions);
        assert_eq!(deduped.sessions[0].title, "inspect:TraycerAI");
    }

    #[test]
    fn keeps_rows_that_only_look_alike() {
        // Different ids, same title: two sessions, not one.
        let payload = AgentSessionsPayload {
            sessions: vec![row("a", None, 2, "daily task"), row("b", None, 1, "daily task")],
            warnings: vec![],
        };
        assert_eq!(one_row_per_session(payload).sessions.len(), 2);
    }
}

#[cfg(test)]
mod usage_tests {
    use super::*;
    use std::path::Path;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(path, body).expect("write");
    }

    /// One store of each tool, then one report from all three.
    ///
    /// This is the seam a usage window reads: each reader sorts its own half, so the merge has to
    /// sort again or the days would be built from a half-ordered stream.
    #[test]
    fn the_three_stores_are_merged_into_one_ordered_report() {
        let dir = tempfile::tempdir().expect("temp dir");
        write(
            &dir.path().join("claude/proj/s1.jsonl"),
            r#"{"type":"assistant","timestamp":"2026-11-12T10:00:00.000Z","message":{"model":"m-a","usage":{"input_tokens":10}}}"#,
        );
        write(
            &dir
                .path()
                .join("pi/--proj--/sess/6f0a/run-0/session.jsonl"),
            r#"{"type":"message","message":{"role":"assistant","provider":"prov","model":"m-b","timestamp":1794580000000,"usage":{"totalTokens":90}}}"#,
        );
        let db = dir.path().join("opencode.db");
        let conn = rusqlite::Connection::open(&db).expect("open");
        conn.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, \
             time_updated INTEGER, data TEXT);",
        )
        .expect("schema");
        conn.execute(
            "INSERT INTO message VALUES ('m1', 's', 1794700000000, 1794700000000, ?1)",
            rusqlite::params![
                r#"{"role":"assistant","providerID":"pv","modelID":"m-c","tokens":{"total":7,"input":7}}"#
            ],
        )
        .expect("row");
        drop(conn);

        let report = usage_events_at(
            UsageStores {
                claude: &[dir.path().join("claude")],
                pi: Some(&dir.path().join("pi")),
                opencode: Some(&db),
                ..UsageStores::default()
            },
            None,
        );
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert_eq!(report.events.len(), 3);
        let models: Vec<String> = report
            .events
            .iter()
            .map(|event| event.model.clone().unwrap_or_default())
            .collect();
        assert_eq!(models, vec!["m-a", "m-b", "m-c"]);

        // Every event says which tool wrote it, which is what the window's tool filter reads.
        let tools: Vec<&str> = report.events.iter().map(|event| event.tool).collect();
        assert_eq!(tools, vec!["claude", "pi", "opencode"]);

        let folded = report.aggregate(0);
        assert_eq!(folded.totals.tokens.total(), 107);
        assert_eq!(folded.days.len(), 3, "{:?}", folded.days);
        assert_eq!(folded.models.len(), 3, "{:?}", folded.models);
        assert_eq!(folded.tools.len(), 3, "{:?}", folded.tools);
        // Each day has exactly one cell here, and it carries the tool the day came from.
        let cell_tools: Vec<&str> = folded
            .days
            .iter()
            .map(|day| day.cells[0].tool.as_str())
            .collect();
        assert_eq!(cell_tools, vec!["claude", "pi", "opencode"]);

        // The same read with a range start: only the two newest events survive, and the total says so.
        let ranged = usage_events_at(
            UsageStores {
                claude: &[dir.path().join("claude")],
                pi: Some(&dir.path().join("pi")),
                opencode: Some(&db),
                ..UsageStores::default()
            },
            Some(1794580000000),
        );
        assert_eq!(ranged.events.len(), 2);
        assert_eq!(ranged.aggregate(0).totals.tokens.total(), 97);
    }

    /// "Installed" is the store being on disk, not usage being in it: an agent with nothing in the
    /// range is still a normal filter to click, and the report already says the range is empty.
    #[test]
    fn only_the_agents_with_a_store_are_offered_for_filtering() {
        let dir = tempfile::tempdir().expect("temp dir");
        let pi = dir.path().join("pi");
        std::fs::create_dir_all(&pi).expect("pi dir");
        let opencode = dir.path().join("opencode.db");
        std::fs::write(&opencode, b"").expect("opencode db");

        let available = available_tools(&UsageStores {
            pi: Some(&pi),
            opencode: Some(&opencode),
            ..UsageStores::default()
        });
        assert_eq!(available, vec!["pi", "opencode"]);
        assert!(available_tools(&UsageStores::default()).is_empty());
    }

    #[test]
    fn a_tool_that_is_not_installed_is_skipped_without_a_word() {
        let report = usage_events_at(UsageStores::default(), None);
        assert!(report.events.is_empty());
        assert!(report.failures.is_empty());
        assert_eq!(report.aggregate(0).totals.events, 0);
    }

    /// One day with a single opencode cell.
    fn usage_day(day: i64, tokens: u64) -> usage::DayUsage {
        let totals = usage::UsageTotals {
            tokens: usage::UsageTokens {
                input: tokens,
                ..Default::default()
            },
            events: 1,
        };
        usage::DayUsage {
            day,
            totals,
            cells: vec![usage::CellUsage {
                tool: "opencode".to_string(),
                provider: Some("p".to_string()),
                model: Some("m".to_string()),
                totals,
            }],
        }
    }

    #[test]
    fn the_payload_sums_the_days_it_returns() {
        // One day the read had and one only the archive still knows: the header has to be the sum of the
        // rows the window draws from those same days, or every view disagrees with the number above it.
        let payload = folded_payload(
            vec![usage_day(0, 100), usage_day(1, 40)],
            None,
            480,
            usage::TokenScope {
                cache_read: true,
                cache_write: true,
            },
            vec![],
            vec!["opencode"],
        );
        assert_eq!(payload.tokens, 140);
        assert_eq!(payload.events, 2);
        assert_eq!(payload.days.len(), 2);
        assert_eq!(
            payload.days.iter().map(|day| day.tokens).sum::<u64>(),
            payload.tokens,
        );
        assert_eq!(payload.days[1].label, usage::day_label(1));
    }
}
