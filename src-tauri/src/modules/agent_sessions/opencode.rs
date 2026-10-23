use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use super::stats::SessionStats;
use super::types::{AgentSession, AgentSessionsPayload};
use crate::modules::proc::capture::{self, Captured, Limits};
use crate::modules::proc::hide_console;

pub(crate) const TOOL: &str = "opencode";

/// opencode 2.0.x writes `session_v2`; `session` is the pre-migration table and
/// stopped being updated (its rows still match what the design doc recorded).
/// Both tables share the columns used here, so only the name differs.
pub(crate) const TABLE_ORDER: &[&str] = &["session_v2", "session"];

const MAX_ROWS: usize = 200;
const BUSY_TIMEOUT: Duration = Duration::from_secs(3);

/// opencode keeps its data under `~/.local/share` on every platform, not in
/// `%LOCALAPPDATA%` on Windows.
pub(crate) fn default_db_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".local/share/opencode/opencode.db"))
}

pub(crate) fn list() -> Result<AgentSessionsPayload, String> {
    let path = default_db_path().ok_or("找不到用户主目录，无法定位 opencode 数据库")?;
    list_at(&path)
}

pub(crate) fn list_at(path: &Path) -> Result<AgentSessionsPayload, String> {
    if !path.is_file() {
        return Err(format!(
            "找不到 opencode 数据库：{}。请确认 opencode 已安装并至少运行过一次。",
            path.display()
        ));
    }
    let table = session_table(path)?;
    let conn = open_read_only(path)?;
    // The two numbers each list row needs are computed right here: tokens come from that
    // row's own columns (old stores lack them, so they stay NULL and the UI shows an em-dash
    // instead of 0), while turns and the last conversation time are counted from the
    // message table.
    // NULL and 0 mean two different things here: NULL = this store does not track tokens
    // at all (old stores), shown as an em-dash; 0 = tracked, but this session really has not
    // spent any yet (newly opened, no messages sent).
    //
    // Turns count **user messages**, not all messages: the assistant posts several per
    // turn (tool calls, reasoning), so counting everything yields "dozens of turns",
    // whereas user messages match the user's own "how many times did I ask".
    // When the message table is empty but tokens were still spent (opencode prunes old
    // messages), fall back to the store's own estimate: one turn uses at least a whole
    // context window, so divide total tokens by it, round up, floor at 1 turn, more
    // honest than claiming "0 turns", and it keeps a 300M-token session from reading as
    // a single turn.
    // Note the COALESCE is **per term**, then summed, rather than wrapping the whole sum:
    // in SQLite `COALESCE((a + b + c + d + e), 0)` evaluates to 0 (not NULL) when all five
    // are NULL, turning "this store does not track tokens" into "tracked 0", which bit
    // both old stores and sessions with pruned messages.
    let tokens_sum = if has_tokens_columns(&conn, &table) {
        "COALESCE(tokens_input, 0) + COALESCE(tokens_output, 0) + COALESCE(tokens_reasoning, 0) + COALESCE(tokens_cache_read, 0) + COALESCE(tokens_cache_write, 0)"
    } else {
        "NULL"
    };
    // There are two generations of message table:
    //   `message`         : written by old opencode, with `role` inside `data`;
    //   `session_message` : written by new opencode, with the role right in `type`.
    // A new install keeps both tables, but **only the new one is updated**. Reading just
    // the old table hides the last few days of conversations entirely (that is how "I
    // chatted all day and the list is still on last week" happens).
    let messages = message_table(&conn);
    let turns_expr = match messages {
        Some((tbl, is_user)) => format!(
            "(SELECT CASE WHEN total > 0 AND (SELECT COUNT(*) FROM {tbl} m WHERE m.session_id = {table}.id) = 0 THEN MAX(1, total / {TOKENS_PER_TURN}) ELSE (SELECT COUNT(*) FROM {tbl} m WHERE m.session_id = {table}.id AND {is_user}) END FROM (SELECT {tokens_sum} AS total) AS s)"
        ),
        None => "NULL".to_string(),
    };
    let last_expr = match messages {
        Some((tbl, _)) => format!(
            "(SELECT MAX(m.time_created) FROM {tbl} m WHERE m.session_id = {table}.id)"
        ),
        None => "NULL".to_string(),
    };
    let sql = format!(
        "SELECT id, parent_id, title, directory, time_updated, {turns_expr}, {tokens_sum}, {last_expr} \
         FROM {table} ORDER BY time_updated DESC LIMIT {MAX_ROWS}"
    );
    let mut statement = conn
        .prepare(&sql)
        .map_err(|e| format!("读取 opencode 会话失败：{e}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<i64>>(7)?,
            ))
        })
        .map_err(|e| format!("读取 opencode 会话失败：{e}"))?;

    let mut sessions = Vec::new();
    let mut warnings = Vec::new();
    for row in rows {
        match row {
            Ok((id, parent_id, title, directory, time_updated, turns, tokens, last_at)) => {
                sessions.push(map_row(
                    &id,
                    parent_id,
                    title,
                    &directory,
                    time_updated,
                    SessionStats {
                        turns: turns.and_then(|count| u32::try_from(count).ok()),
                        tokens: tokens.and_then(|value| u64::try_from(value).ok()),
                        last_at_ms: last_at,
                    },
                ));
            }
            Err(error) => warnings.push(format!("跳过一行无法解析的 opencode 会话：{error}")),
        }
    }
    Ok(AgentSessionsPayload { sessions, warnings })
}

/// Tokens assumed per turn (opencode deletes pruned old messages from the `message`
/// table, but the token columns of `session_v2` keep growing). 200k is slightly below a
/// typical context window, so the estimate does not overshoot by much.
const TOKENS_PER_TURN: u64 = 200_000;

/// Which table holds messages, and how to tell a user message apart.
///
/// New opencode uses `session_message` (the role is the `type` column), old opencode uses
/// `message` (the role is buried in the JSON of `data`). **Prefer the new table**: when
/// both exist, the old one is no longer updated. With neither (a very old store) this
/// returns None and the two numbers in the UI show an em-dash.
fn message_table(conn: &Connection) -> Option<(&'static str, &'static str)> {
    let has = |name: &str| -> bool {
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [name],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .unwrap_or(false)
    };
    if has("session_message") {
        // New table: the `type` column is 'user' / 'assistant' / 'system' / ...
        Some(("session_message", "m.type = 'user'"))
    } else if has("message") {
        Some(("message", "json_extract(m.data, '$.role') = 'user'"))
    } else {
        None
    }
}

/// Whether this table has the token columns (old stores' `session` table does not).
fn has_tokens_columns(conn: &Connection, table: &str) -> bool {
    let sql =
        format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = 'tokens_input'");
    conn.query_row(&sql, [], |row| row.get::<_, i64>(0))
        .map(|count| count > 0)
        .unwrap_or(false)
}

pub(crate) fn session_table(path: &Path) -> Result<String, String> {
    let conn = open_read_only(path)?;
    for candidate in TABLE_ORDER {
        let found: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [candidate],
                |row| row.get(0),
            )
            .map_err(|e| format!("读取 opencode 数据库结构失败：{e}"))?;
        if found > 0 {
            return Ok((*candidate).to_string());
        }
    }
    Err("opencode 数据库里既没有 session_v2 也没有 session 表".to_string())
}

/// A WAL database can only be opened read-only when its `-shm` sidecar stays
/// writable, so a failure here is a real error to show, never an empty list.
pub(super) fn open_read_only(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| {
        format!(
            "无法只读打开 opencode 数据库 {}：{e}。若 opencode 正在写入，请稍后重试。",
            path.display()
        )
    })?;
    conn.busy_timeout(BUSY_TIMEOUT)
        .map_err(|e| format!("设置 opencode 数据库超时失败：{e}"))?;
    Ok(conn)
}

/// Renaming writes to the store, so this opens read-write: when opencode is running
/// concurrently, `busy_timeout` waits a while, and if it never yields (the database stays
/// locked) the error is reported honestly rather than forced through.
fn open_rw(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(
        |e| {
            format!(
                "无法写入 opencode 数据库 {}：{e}。若 opencode 正在写入，请稍后重试。",
                path.display()
            )
        },
    )?;
    conn.busy_timeout(BUSY_TIMEOUT)
        .map_err(|e| format!("设置 opencode 数据库超时失败：{e}"))?;
    Ok(conn)
}

const CLI: &str = "opencode";
const DELETE_TIMEOUT: Duration = Duration::from_secs(30);
const DELETE_LIMITS: Limits = Limits {
    stdout: 8 * 1024,
    stderr: 8 * 1024,
    stop_on_stdout_cap: false,
};

pub(crate) fn delete_arguments(id: &str) -> Vec<&str> {
    vec!["session", "delete", id]
}

/// The CLI is an npm shim: `opencode.cmd` next to a `.exe` under `node_modules`.
/// `CreateProcess` does not run a `.cmd`, so Windows goes through the shell that
/// resolves shims. Every argument is a validated session id, so there is nothing
/// for that shell to reparse; on a machine where the CLI is a real executable
/// the same line still works.
fn delete_command(directory: &Path, id: &str) -> Command {
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("cmd");
        command.arg("/C").arg(CLI);
        command
    };
    #[cfg(not(windows))]
    let mut command = Command::new(CLI);
    command.args(delete_arguments(id));
    capture_ready(command, directory)
}

/// `capture::run` refuses a command whose pipes are not in place, and it fails at
/// spawn time with "no stdout pipe" rather than anything actionable.
fn capture_ready(mut command: Command, directory: &Path) -> Command {
    command
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    command
}

/// Deletes through opencode's own command so it also removes the session's child
/// sessions and the rows it owns; the 5.6 GB WAL database is never written here.
///
/// The command has to run inside the session's directory (that is how it resolves
/// the session), but that directory may be gone: the project was deleted, the
/// session row stayed. Launching there fails at spawn time with the system's
/// "The directory name is invalid" (Windows error 267), and the session could
/// then never be deleted at all. So: use the recorded directory when it still
/// exists, otherwise any directory we know is there. The id is all the command
/// needs to find the session.
pub(crate) fn delete_at(db: &Path, id: &str) -> Result<(), String> {
    let directory = session_directory(db, id)?;
    let recorded = Path::new(&directory);
    let workdir = if recorded.is_dir() {
        recorded.to_path_buf()
    } else {
        std::env::temp_dir()
    };
    let mut command = delete_command(&workdir, id);
    let captured = capture::run(&mut command, DELETE_TIMEOUT, DELETE_LIMITS)
        .map_err(|e| format!("无法执行 opencode session delete：{e}"))?;
    if captured.timed_out {
        return Err("删除超时：opencode 在 30 秒内没有返回".to_string());
    }
    if captured.exit_code != Some(0) {
        return Err(cli_failure(&captured));
    }
    Ok(())
}

/// Measured: an unknown id exits 1 and prints `Session not found: <id>`, so the
/// exit code is enough to call it a failure and the text explains it.
fn cli_failure(captured: &Captured) -> String {
    let text = if captured.stderr.is_empty() {
        &captured.stdout
    } else {
        &captured.stderr
    };
    let text = String::from_utf8_lossy(text).trim().to_string();
    if text.is_empty() {
        format!("opencode session delete 退出码 {:?}", captured.exit_code)
    } else {
        text
    }
}

/// The command resolves a session against the directory it runs in, so that
/// directory is read from the database rather than accepted from the caller.
pub(crate) fn session_directory(path: &Path, id: &str) -> Result<String, String> {
    let table = session_table(path)?;
    let conn = open_read_only(path)?;
    conn.query_row(
        &format!("SELECT directory FROM {table} WHERE id = ?1"),
        [id],
        |row| row.get::<_, String>(0),
    )
    .map_err(|_| format!("opencode 里找不到会话 {id}"))
}

/// Rename a session.
///
/// Only the `title` column changes; nothing else (`time_updated` etc.) is touched: a
/// rename is not a conversation, so it must not push the session to the top of the list.
/// opencode itself writes this column from `/rename`.
pub(crate) fn rename_at(path: &Path, id: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("会话名不能为空".to_string());
    }
    let table = session_table(path)?;
    let conn = open_rw(path)?;
    let changed = conn
        .execute(
            &format!("UPDATE {table} SET title = ?1 WHERE id = ?2"),
            rusqlite::params![name, id],
        )
        .map_err(|e| format!("写入 opencode 会话名失败：{e}"))?;
    if changed == 0 {
        return Err(format!("opencode 里找不到会话 {id}"));
    }
    Ok(())
}

pub(crate) fn exists_at(path: &Path, id: &str) -> Result<bool, String> {
    let table = session_table(path)?;
    let conn = open_read_only(path)?;
    let found: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE id = ?1"),
            [id],
            |row| row.get(0),
        )
        .map_err(|e| format!("读取 opencode 会话失败：{e}"))?;
    Ok(found > 0)
}

pub(crate) fn map_row(
    id: &str,
    parent_id: Option<String>,
    title: Option<String>,
    directory: &str,
    time_updated: i64,
    stats: SessionStats,
) -> AgentSession {
    let title = title
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| directory_name(directory));
    AgentSession {
        tool: TOOL.to_string(),
        id: id.to_string(),
        title,
        cwd: directory.to_string(),
        updated_at_ms: time_updated,
        parent_id,
        stats,
    }
}

fn directory_name(directory: &str) -> String {
    let trimmed = directory.trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(trimmed)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(table: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("opencode.db");
        let conn = Connection::open(&path).expect("open");
        conn.execute_batch(&format!(
            "CREATE TABLE {table} (
                id TEXT PRIMARY KEY,
                parent_id TEXT,
                title TEXT,
                directory TEXT NOT NULL,
                time_updated INTEGER NOT NULL,
                tokens_input INTEGER,
                tokens_output INTEGER,
                tokens_reasoning INTEGER,
                tokens_cache_read INTEGER,
                tokens_cache_write INTEGER
            );
            CREATE TABLE IF NOT EXISTS message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT
            );"
        ))
        .expect("create table");
        (dir, path)
    }

    fn insert_message(path: &Path, id: &str, session_id: &str, role: &str, time_created: i64) {
        let conn = Connection::open(path).expect("open");
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, time_updated, data)              VALUES (?1, ?2, ?3, ?3, ?4)",
            rusqlite::params![id, session_id, time_created, format!("{{\"role\":\"{role}\"}}")],
        )
        .expect("insert message");
    }

    fn insert(
        path: &Path,
        table: &str,
        id: &str,
        parent_id: Option<&str>,
        title: Option<&str>,
        directory: &str,
        time_updated: i64,
    ) {
        let conn = Connection::open(path).expect("open");
        conn.execute(
            &format!(
                "INSERT INTO {table} (id, parent_id, title, directory, time_updated) \
                 VALUES (?1, ?2, ?3, ?4, ?5)"
            ),
            rusqlite::params![id, parent_id, title, directory, time_updated],
        )
        .expect("insert");
    }

    #[test]
    fn maps_a_row_with_title() {
        let session = map_row(
            "ses_1",
            None,
            Some("Example App".to_string()),
            "F:/work/example-app",
            1_791_820_691_308,
            SessionStats::default(),
        );
        assert_eq!(session.id, "ses_1");
        assert_eq!(session.title, "Example App");
        assert_eq!(session.cwd, "F:/work/example-app");
        assert_eq!(session.parent_id, None);
        assert_eq!(session.tool, "opencode");
    }

    #[test]
    fn blank_title_falls_back_to_directory_name() {
        let session = map_row(
            "ses_2",
            None,
            Some("   ".to_string()),
            "F:/x/bear_bill",
            1,
            SessionStats::default(),
        );
        assert_eq!(session.title, "bear_bill");
    }

    #[test]
    fn turns_count_user_messages_not_every_message() {
        // The assistant posts several messages per turn (tool calls, reasoning), so
        // counting all messages inflates the number several-fold.
        let (_dir, path) = temp_db("session_v2");
        insert(&path, "session_v2", "ses_1", None, Some("t"), "F:/x", 10);
        insert_message(&path, "m1", "ses_1", "user", 100);
        insert_message(&path, "m2", "ses_1", "assistant", 200);
        insert_message(&path, "m3", "ses_1", "assistant", 300);
        insert_message(&path, "m4", "ses_1", "user", 400);
        let payload = list_at(&path).expect("应能读");
        let stats = payload.sessions[0].stats;
        assert_eq!(stats.turns, Some(2), "两条用户消息就是两轮");
        assert_eq!(stats.last_at_ms, Some(400), "最后对话时间也是按消息算");
    }

    #[test]
    fn a_session_whose_messages_were_pruned_keeps_an_estimate_instead_of_zero() {
        // opencode prunes old messages: the message table is empty but the token columns
        // remain, so claiming "0 turns" would be a lie.
        let (_dir, path) = temp_db("session_v2");
        insert(&path, "session_v2", "ses_1", None, Some("t"), "F:/x", 10);
        let conn = Connection::open(&path).expect("open");
        conn.execute(
            "UPDATE session_v2 SET tokens_input = 800000 WHERE id = 'ses_1'",
            [],
        )
        .expect("update");
        let payload = list_at(&path).expect("应能读");
        assert_eq!(payload.sessions[0].stats.turns, Some(4), "80 万 tokens / 20 万");
        assert_eq!(payload.sessions[0].stats.last_at_ms, None, "没有消息就没有对话时间");
    }

    #[test]
    fn a_session_that_really_has_nothing_says_zero_turns_not_unknown() {
        let (_dir, path) = temp_db("session_v2");
        insert(&path, "session_v2", "ses_1", None, Some("t"), "F:/x", 10);
        let payload = list_at(&path).expect("应能读");
        let stats = payload.sessions[0].stats;
        assert_eq!(stats.turns, Some(0));
        assert_eq!(stats.tokens, Some(0), "新库记了 tokens，只是确实是 0");
    }

    #[test]
    fn an_old_store_without_token_columns_leaves_them_unknown() {
        let (_dir, path) = temp_db("session");
        // An old store has no token columns, and "unknown" must not be written as 0.
        let conn = Connection::open(&path).expect("open");
        conn.execute_batch("ALTER TABLE session DROP COLUMN tokens_input").ok();
        insert(&path, "session", "ses_1", None, Some("t"), "F:/x", 10);
        insert_message(&path, "m1", "ses_1", "user", 100);
        let payload = list_at(&path).expect("应能读");
        let stats = payload.sessions[0].stats;
        assert_eq!(stats.turns, Some(1));
        assert_eq!(stats.tokens, None, "老库不记 tokens，只能是「不知道」");
    }

    #[test]
    fn null_title_and_trailing_slash_fall_back_to_directory_name() {
        let session = map_row(
            "ses_3",
            None,
            None,
            "F:/x/PasteLabel/",
            1,
            SessionStats::default(),
        );
        assert_eq!(session.title, "PasteLabel");
    }

    #[test]
    fn keeps_parent_id_for_subagent_sessions() {
        let session = map_row(
            "ses_4",
            Some("ses_1".to_string()),
            None,
            "F:/x",
            1,
            SessionStats::default(),
        );
        assert_eq!(session.parent_id.as_deref(), Some("ses_1"));
    }

    #[test]
    fn prefers_session_v2_when_present() {
        let (_dir, path) = temp_db("session_v2");
        assert_eq!(session_table(&path).expect("table"), "session_v2");
    }

    #[test]
    fn falls_back_to_the_legacy_session_table() {
        let (_dir, path) = temp_db("session");
        insert(&path, "session", "ses_old", None, Some("旧会话"), "F:/old", 10);
        assert_eq!(session_table(&path).expect("table"), "session");
        let payload = list_at(&path).expect("list");
        assert_eq!(payload.sessions.len(), 1);
        assert_eq!(payload.sessions[0].id, "ses_old");
    }

    #[test]
    fn prefers_session_v2_over_the_legacy_table_in_one_database() {
        let (_dir, path) = temp_db("session");
        insert(&path, "session", "ses_old", None, Some("old"), "F:/old", 10);
        let conn = Connection::open(&path).expect("open");
        conn.execute_batch(
            "CREATE TABLE session_v2 (
                id TEXT PRIMARY KEY,
                parent_id TEXT,
                title TEXT,
                directory TEXT NOT NULL,
                time_updated INTEGER NOT NULL
            );",
        )
        .expect("create");
        drop(conn);
        insert(&path, "session_v2", "ses_new", None, Some("new"), "F:/new", 20);
        let payload = list_at(&path).expect("list");
        assert_eq!(payload.sessions.len(), 1);
        assert_eq!(payload.sessions[0].id, "ses_new");
    }

    #[test]
    fn orders_by_time_updated_desc_and_keeps_children() {
        let (_dir, path) = temp_db("session_v2");
        insert(&path, "session_v2", "ses_a", None, Some("A"), "F:/a", 10);
        insert(&path, "session_v2", "ses_b", Some("ses_a"), Some("B"), "F:/b", 30);
        let payload = list_at(&path).expect("list");
        let ids: Vec<&str> = payload.sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["ses_b", "ses_a"]);
        assert_eq!(payload.sessions[0].parent_id.as_deref(), Some("ses_a"));
    }

    #[test]
    fn database_without_any_known_table_is_an_error() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("other.db");
        Connection::open(&path).expect("open");
        let error = list_at(&path).expect_err("should fail");
        assert!(error.contains("session"), "unexpected error: {error}");
    }

    #[test]
    fn missing_database_is_a_clear_error_not_an_empty_list() {
        let dir = tempfile::tempdir().expect("temp dir");
        let error = list_at(&dir.path().join("nope.db")).expect_err("should fail");
        assert!(error.contains("opencode"), "unexpected error: {error}");
    }

    #[test]
    fn builds_the_delete_arguments_it_documents() {
        assert_eq!(delete_arguments("ses_1"), vec!["session", "delete", "ses_1"]);
    }

    /// A session stays listed after its project directory was deleted (the reported "The
    /// directory name is invalid"): deletion must not get stuck because of it: if the
    /// directory is unusable, run the command from the temp directory instead. This uses
    /// a directory that certainly does not exist as the recorded one.
    #[test]
    fn deleting_a_session_whose_directory_is_gone_still_runs() {
        let (dir, db) = temp_db(TABLE_ORDER[0]);
        insert(
            &db,
            TABLE_ORDER[0],
            "ses_gone",
            None,
            Some("DSH Desktop"),
            "D:/no/such/project",
            1,
        );
        // The command itself fails (opencode is not installed here), but the reason must
        // not be "directory does not exist": reaching execution is enough to satisfy the
        // invariant.
        let error = delete_at(&db, "ses_gone").expect_err("no CLI in the test env");
        assert!(
            !error.contains("目录名称无效")
                && !error.contains("The directory name is invalid"),
            "still launched in the deleted directory: {error}"
        );
        drop(dir);
    }

    #[test]
    fn resolves_the_program_the_platform_needs() {
        let command = delete_command(Path::new("F:/x"), "ses_1");
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        #[cfg(windows)]
        {
            // The installed CLI is `opencode.cmd`, which CreateProcess will not run.
            assert_eq!(command.get_program().to_string_lossy(), "cmd");
            assert_eq!(args, ["/C", "opencode", "session", "delete", "ses_1"]);
        }
        #[cfg(not(windows))]
        {
            assert_eq!(command.get_program().to_string_lossy(), "opencode");
            assert_eq!(args, ["session", "delete", "ses_1"]);
        }
        assert_eq!(command.get_current_dir(), Some(Path::new("F:/x")));
    }

    #[test]
    fn a_missing_row_is_a_clear_error() {
        let (_dir, path) = temp_db("session_v2");
        let error = session_directory(&path, "ses_nope").expect_err("should fail");
        assert!(error.contains("ses_nope"), "unexpected error: {error}");
    }

    #[test]
    fn reads_the_directory_and_the_presence_of_a_row() {
        let (_dir, path) = temp_db("session_v2");
        insert(&path, "session_v2", "ses_1", None, Some("t"), "F:/x", 1);
        assert_eq!(session_directory(&path, "ses_1").expect("dir"), "F:/x");
        assert!(exists_at(&path, "ses_1").expect("exists"));
        assert!(!exists_at(&path, "ses_2").expect("exists"));
    }

    #[test]
    fn a_failed_run_reports_what_the_cli_said() {
        let captured = Captured {
            stdout: b"Session not found: ses_x\n".to_vec(),
            ..Default::default()
        };
        assert_eq!(cli_failure(&captured), "Session not found: ses_x");
    }

    #[test]
    fn the_command_is_ready_for_the_capture_helper() {
        // Locks the contract `capture::run` documents: without the pipes it fails
        // at spawn time with "no stdout pipe", which is how the first real delete
        // attempt ended.
        #[cfg(windows)]
        let command = {
            let mut command = Command::new("cmd");
            command.args(["/C", "echo", "hi"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "echo hi"]);
            command
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let mut command = capture_ready(command, dir.path());
        let captured =
            capture::run(&mut command, Duration::from_secs(10), DELETE_LIMITS).expect("run");
        assert_eq!(captured.exit_code, Some(0));
        assert!(
            String::from_utf8_lossy(&captured.stdout).contains("hi"),
            "stdout was not captured"
        );
    }

    #[test]
    fn an_empty_failure_output_falls_back_to_the_exit_code() {
        let captured = Captured {
            exit_code: Some(2),
            ..Default::default()
        };
        assert!(cli_failure(&captured).contains('2'), "{}", cli_failure(&captured));
    }
}