pub mod types;

mod delete;
mod image;
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

/// Looks up the image a message attached, by the name the terminal printed.
/// It reads sqlite, so it runs on the blocking pool as well.
#[tauri::command]
pub async fn agent_sessions_image(
    name: String,
    directory: Option<String>,
) -> Result<Option<String>, String> {
    crate::modules::fs::blocking(move || image::data_url_by_name(&name, directory.as_deref())).await
}