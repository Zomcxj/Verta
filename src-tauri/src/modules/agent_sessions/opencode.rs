use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use super::types::{AgentSession, AgentSessionsPayload};

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
    let sql = format!(
        "SELECT id, parent_id, title, directory, time_updated FROM {table} \
         ORDER BY time_updated DESC LIMIT {MAX_ROWS}"
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
            ))
        })
        .map_err(|e| format!("读取 opencode 会话失败：{e}"))?;

    let mut sessions = Vec::new();
    let mut warnings = Vec::new();
    for row in rows {
        match row {
            Ok((id, parent_id, title, directory, time_updated)) => {
                sessions.push(map_row(&id, parent_id, title, &directory, time_updated));
            }
            Err(error) => warnings.push(format!("跳过一行无法解析的 opencode 会话：{error}")),
        }
    }
    Ok(AgentSessionsPayload { sessions, warnings })
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
fn open_read_only(path: &Path) -> Result<Connection, String> {
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

pub(crate) fn map_row(
    id: &str,
    parent_id: Option<String>,
    title: Option<String>,
    directory: &str,
    time_updated: i64,
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
                time_updated INTEGER NOT NULL
            );"
        ))
        .expect("create table");
        (dir, path)
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
            Some("GitShow Go".to_string()),
            "F:/VibeCoding_workspace/GitShow",
            1_791_820_691_308,
        );
        assert_eq!(session.id, "ses_1");
        assert_eq!(session.title, "GitShow Go");
        assert_eq!(session.cwd, "F:/VibeCoding_workspace/GitShow");
        assert_eq!(session.parent_id, None);
        assert_eq!(session.tool, "opencode");
    }

    #[test]
    fn blank_title_falls_back_to_directory_name() {
        let session = map_row("ses_2", None, Some("   ".to_string()), "F:/x/bear_bill", 1);
        assert_eq!(session.title, "bear_bill");
    }

    #[test]
    fn null_title_and_trailing_slash_fall_back_to_directory_name() {
        let session = map_row("ses_3", None, None, "F:/x/PasteLabel/", 1);
        assert_eq!(session.title, "PasteLabel");
    }

    #[test]
    fn keeps_parent_id_for_subagent_sessions() {
        let session = map_row("ses_4", Some("ses_1".to_string()), None, "F:/x", 1);
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
}