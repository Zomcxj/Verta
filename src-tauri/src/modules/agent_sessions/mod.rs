pub mod types;

mod opencode;
mod pi;

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