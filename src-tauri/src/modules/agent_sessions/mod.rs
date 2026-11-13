pub mod types;

mod claude;
mod delete;
mod image;
mod opencode;
mod pi;
mod service_turns;
pub mod stats;
pub mod watch;
mod wsl;

use delete::{DeleteReport, SessionTarget};
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
        // Reading a distro's own `~/.claude/projects` is not implemented, so a distro answers with an
        // empty list: answering with the local one instead would list every session once per distro.
        // The comment here used to say Claude Code "has none" over there, which is not true - it
        // writes that path on whichever side it runs, and that gap is why a distro can look empty
        // while the distribution has been using it all along.
        (claude::TOOL, Some(distro)) => Ok(wsl::claude_is_absent(distro)),
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
