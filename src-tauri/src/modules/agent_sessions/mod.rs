pub mod types;

mod delete;
mod image;
mod opencode;
mod pi;
pub mod stats;
pub mod watch;
mod wsl;

use delete::{DeleteReport, SessionTarget};
use types::AgentSessionsPayload;

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
    crate::modules::fs::blocking(move || match (tool.as_str(), distro.as_deref()) {
        (opencode::TOOL, Some(distro)) => wsl::list(distro),
        (opencode::TOOL, None) => opencode::list(),
        (pi::TOOL, Some(distro)) => Ok(wsl::pi_is_absent(distro)),
        (pi::TOOL, None) => pi::list(),
        (other, _) => Err(format!("不支持的会话工具：{other}")),
    })
    .await
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