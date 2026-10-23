//! Reads a distro's opencode session store.
//!
//! The store lives inside the distro's filesystem and comes to gigabytes, and
//! its database is a WAL one. Reading it across `\\wsl.localhost` cannot take
//! the shared-memory lock that needs (measured: fourteen seconds, then
//! `database is locked`), and the `immutable=1` fallback answers quickly but
//! ignores whatever has not been checkpointed, so it can quietly report a stale
//! list. A query run inside the distro is the only read that sees all of it,
//! which is what this does.
//!
//! The query travels as a file rather than as an argument: `wsl.exe` rewrites
//! quotes and newlines on the way through, and a multi-line program does not
//! survive that.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Deserialize;

use super::opencode::TOOL;
use super::stats::SessionStats;
use super::types::{AgentSession, AgentSessionsPayload};

/// Rows asked for, matching what the reader for this machine asks for: the panel
/// shows the newest sessions and the store is far too large to walk.
const MAX_ROWS: usize = 200;

/// The query, run by the distro's own python3. `__LIMIT__` is substituted so the
/// count is spelled once.
const SCRIPT: &str = r#"import json, os, sqlite3, sys

path = os.path.expanduser("~/.local/share/opencode/opencode.db")
if not os.path.isfile(path):
    sys.stderr.write("这个发行版里没有 opencode 数据库，可能还没在里面跑过 opencode：" + path)
    sys.exit(0)

con = sqlite3.connect("file:" + path + "?mode=ro", uri=True, timeout=3)
rows = None
for table in ("session_v2", "session"):
    try:
        # Turns / tokens / last-talked time follow the same rules as the query for this
        # machine; give NULL when an old store has no tokens columns.
        cols = {r[1] for r in con.execute("pragma table_info('" + table + "')")}
        tokens = (
            "coalesce(tokens_input,0)+coalesce(tokens_output,0)+coalesce(tokens_reasoning,0)"
            "+coalesce(tokens_cache_read,0)+coalesce(tokens_cache_write,0)"
            if "tokens_input" in cols else "NULL"
        )
        # Two generations of message table: new versions write `session_message` (the
        # `type` column is the role), old ones write `message` (the role sits in the JSON
        # under data). Prefer the new table — the old one stops being updated once both exist.
        msg_tables = {r[0] for r in con.execute("select name from sqlite_master where type='table'")}
        if "session_message" in msg_tables:
            msg_table, is_user = "session_message", "m.type = 'user'"
        elif "message" in msg_tables:
            msg_table, is_user = "message", "json_extract(m.data, '$.role') = 'user'"
        else:
            msg_table, is_user = None, None
        # Turns count **user messages** (the assistant posts several per turn).
        turns = (
            "(select count(*) from " + msg_table + " m where m.session_id = " + table + ".id and " + is_user + ")"
            if msg_table else "NULL"
        )
        rows = con.execute(
            "select id, parent_id, title, directory, time_updated, "
            + turns + ", "
            + tokens + ", "
            "(select max(m.time_created) from " + (msg_table or "message") + " m where m.session_id = " + table + ".id) "
            "from " + table + " order by time_updated desc limit __LIMIT__"
        ).fetchall()
    except sqlite3.Error:
        continue
    break
if rows is None:
    sys.stderr.write("这个发行版的 opencode 数据库里既没有 session_v2 也没有 session 表")
    sys.exit(0)

for row in rows:
    print(json.dumps({
        "id": row[0],
        "parentId": row[1],
        "title": row[2] if row[2] is None else str(row[2]),
        "directory": row[3],
        "updatedAtMs": row[4],
        "turns": row[5],
        "tokens": row[6],
        "lastAtMs": row[7],
    }))
"#;

/// The list of sessions one distro has, or an error to show as-is.
pub(crate) fn list(distro: &str) -> Result<AgentSessionsPayload, String> {
    #[cfg(not(windows))]
    {
        let _ = distro;
        Err("只有 Windows 上的 Verta 能读取 WSL 发行版里的会话".to_string())
    }
    #[cfg(windows)]
    {
        let script = write_script()?;
        let inside = wsl_path(&script)
            .ok_or_else(|| format!("临时查询脚本不在磁盘上，无法让发行版读到：{}", script.display()));
        let stdout = inside.and_then(|path| {
            crate::modules::workspace::wsl_exec_capture(distro, "python3", &[&path])
                .map_err(|e| format!("在发行版 {distro} 内查询会话失败：{e}"))
        });
        let _ = std::fs::remove_file(&script);
        stdout.map(|stdout| parse_rows(&stdout))
    }
}

/// WSL resolves the platform's own `pi` to the Windows binary, so a distro has
/// no `~/.pi` store of its own. Saying so is the honest answer; an empty list
/// would read as "nothing there yet".
pub(crate) fn pi_is_absent(distro: &str) -> AgentSessionsPayload {
    AgentSessionsPayload {
        sessions: Vec::new(),
        warnings: vec![format!(
            "发行版 {distro} 里没有 pi 的会话：WSL 内的 pi 指向 Windows 上的同一个程序，会话仍在 Windows 侧"
        )],
    }
}

/// One line of the query's output.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireRow {
    id: String,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    directory: Option<String>,
    #[serde(default)]
    updated_at_ms: i64,
    #[serde(default)]
    turns: Option<i64>,
    #[serde(default)]
    tokens: Option<i64>,
    #[serde(default)]
    last_at_ms: Option<i64>,
}

/// Turns the query's output into sessions. A line that does not parse is
/// reported rather than dropped, so a damaged row shows up instead of quietly
/// shrinking the list.
pub(crate) fn parse_rows(stdout: &str) -> AgentSessionsPayload {
    let mut sessions = Vec::new();
    let mut warnings = Vec::new();
    for line in stdout.lines().filter(|line| !line.trim().is_empty()) {
        match serde_json::from_str::<WireRow>(line) {
            Ok(row) => sessions.push(AgentSession {
                tool: TOOL.to_string(),
                id: row.id,
                title: row.title.unwrap_or_default(),
                cwd: row.directory.unwrap_or_default(),
                updated_at_ms: row.updated_at_ms,
                parent_id: row.parent_id,
                stats: SessionStats {
                    turns: row.turns.and_then(|count| u32::try_from(count).ok()),
                    tokens: row.tokens.and_then(|value| u64::try_from(value).ok()),
                    last_at_ms: row.last_at_ms,
                },
            }),
            Err(error) => {
                warnings.push(format!("跳过一行无法解析的发行版会话：{error}"));
            }
        }
    }
    AgentSessionsPayload { sessions, warnings }
}

fn script() -> String {
    SCRIPT.replace("__LIMIT__", &MAX_ROWS.to_string())
}

/// Writes the query somewhere the distro can read it. The platform temp
/// directory is on the Windows drive, which every distro has under `/mnt`.
///
/// The name carries a per-call counter as well as the process id: the panel
/// refreshes can overlap, and with a name derived from the process alone one
/// call's cleanup would delete the file out from under the other (measured: the
/// second query failed with "can't open file ... No such file or directory").
fn write_script() -> Result<PathBuf, String> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "verta-wsl-sessions-{}-{}.py",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&path, script())
        .map_err(|e| format!("写临时查询脚本失败（{}）：{e}", path.display()))?;
    Ok(path)
}

/// Windows path to the path a distro sees for the same file.
pub(crate) fn wsl_path(path: &Path) -> Option<String> {
    let text = path.to_str()?;
    let mut chars = text.chars();
    let drive = chars.next()?;
    if !drive.is_ascii_alphabetic() || chars.next()? != ':' {
        return None;
    }
    let rest = &text[2..];
    if !rest.starts_with('\\') && !rest.starts_with('/') {
        return None;
    }
    Some(format!(
        "/mnt/{}{}",
        drive.to_ascii_lowercase(),
        rest.replace('\\', "/")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_session_line() {
        let payload = parse_rows(
            r#"{"id":"ses_1","parentId":null,"title":"Verta Go","directory":"/home/cxj/workspace/x","updatedAtMs":1792307910721}"#,
        );
        assert_eq!(payload.warnings, Vec::<String>::new());
        assert_eq!(
            payload.sessions,
            vec![AgentSession {
                tool: "opencode".to_string(),
                id: "ses_1".to_string(),
                title: "Verta Go".to_string(),
                cwd: "/home/cxj/workspace/x".to_string(),
                updated_at_ms: 1_792_307_910_721,
                parent_id: None,
                stats: SessionStats::default(),
            }]
        );
    }

    #[test]
    fn keeps_the_parent_of_a_subagent_session() {
        let payload = parse_rows(
            r#"{"id":"ses_child","parentId":"ses_parent","title":"task","directory":"/home/cxj","updatedAtMs":5}"#,
        );
        assert_eq!(
            payload.sessions[0].parent_id.as_deref(),
            Some("ses_parent")
        );
    }

    #[test]
    fn reports_a_line_that_does_not_parse() {
        let payload = parse_rows(
            "{\"id\":\"ses_1\",\"updatedAtMs\":1}\n这行不是 JSON\n{\"id\":\"ses_2\",\"updatedAtMs\":2}",
        );
        assert_eq!(payload.sessions.len(), 2);
        assert_eq!(payload.warnings.len(), 1);
        assert!(payload.warnings[0].contains("跳过一行无法解析的发行版会话"));
    }

    #[test]
    fn a_missing_title_or_directory_is_not_a_failure() {
        let payload = parse_rows(r#"{"id":"ses_1","updatedAtMs":3}"#);
        assert_eq!(payload.warnings, Vec::<String>::new());
        assert_eq!(payload.sessions[0].title, "");
        assert_eq!(payload.sessions[0].cwd, "");
    }

    #[test]
    fn ignores_blank_output() {
        assert!(parse_rows("\n  \n").sessions.is_empty());
    }

    #[test]
    fn spells_the_row_limit_once() {
        assert!(script().contains("limit 200"));
        assert!(!script().contains("__LIMIT__"));
    }

    #[test]
    fn maps_a_windows_path_into_the_distro() {
        assert_eq!(
            wsl_path(Path::new(r"C:\Users\x\Temp\q.py")).as_deref(),
            Some("/mnt/c/Users/x/Temp/q.py")
        );
        assert_eq!(
            wsl_path(Path::new("D:/tmp/q.py")).as_deref(),
            Some("/mnt/d/tmp/q.py")
        );
    }

    #[test]
    fn refuses_a_path_with_no_drive() {
        assert_eq!(wsl_path(Path::new(r"\\server\share\q.py")), None);
        assert_eq!(wsl_path(Path::new("relative/q.py")), None);
    }

    #[test]
    fn two_writes_never_share_one_file() {
        // Panel refreshes overlap; a shared file name would be deleted by whichever run
        // finishes first, leaving the other unable to find its script.
        let first = write_script().expect("first script");
        let second = write_script().expect("second script");
        assert_ne!(first, second);
        assert!(first.exists(), "{} 应该已写下", first.display());
        assert!(second.exists(), "{} 应该已写下", second.display());
        std::fs::remove_file(&first).expect("cleanup");
        std::fs::remove_file(&second).expect("cleanup");
    }

    #[test]
    fn says_why_a_distro_has_no_pi_sessions() {
        let payload = pi_is_absent("Ubuntu-22.04");
        assert!(payload.sessions.is_empty());
        assert!(payload.warnings[0].contains("Ubuntu-22.04"));
    }
}