pub mod types;

mod delete;
mod opencode;
mod pi;
pub mod watch;

use delete::{DeleteReport, SessionTarget};
use types::AgentSessionsPayload;

/// Reads sqlite and session files, so it runs on the blocking pool: Tauri runs a
/// non-async command inline in the IPC handler (the main thread on macOS).
#[tauri::command]
pub async fn agent_sessions_list(tool: String) -> Result<AgentSessionsPayload, String> {
    crate::modules::fs::blocking(move || match tool.as_str() {
        opencode::TOOL => opencode::list(),
        pi::TOOL => pi::list(),
        other => Err(format!("不支持的会话工具：{other}")),
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