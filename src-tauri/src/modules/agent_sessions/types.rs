use super::stats::SessionStats;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub tool: String,
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub updated_at_ms: i64,
    pub parent_id: Option<String>,
    /// The numbers a session list row needs; each item is `None` when data is missing,
    /// not 0.
    #[serde(flatten)]
    pub stats: SessionStats,
}

/// `warnings` carries per-record failures so a damaged row or file is visible in
/// the UI instead of silently shrinking the list.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionsPayload {
    pub sessions: Vec<AgentSession>,
    pub warnings: Vec<String>,
}