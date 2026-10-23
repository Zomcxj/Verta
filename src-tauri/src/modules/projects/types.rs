use serde::{Deserialize, Serialize};

use crate::modules::workspace::WorkspaceEnv;

/// A project whose status the frontend is asking about. The environment travels with the
/// request: one list may mix host projects with distro projects, and status must be read
/// on the side the project actually lives on.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTarget {
    pub path: String,
    #[serde(default)]
    pub workspace: WorkspaceEnv,
}

/// A project's status. `kind` says what was found; the remaining fields are filled
/// accordingly:
///
/// - `repo`: it really is a git repository, so the other fields are valid;
/// - `notRepo`: the path exists but neither it nor any parent is inside a repository;
/// - `missing`: the path does not exist (drive unplugged, directory renamed, distro not
///   running);
/// - `error`: any other failure, with the cause carried in `error` — never disguised as
///   a clean tree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatus {
    pub path: String,
    pub name: String,
    pub workspace: WorkspaceEnv,
    pub kind: &'static str,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub detached: bool,
    /// Number of uncommitted files (untracked included).
    pub dirty: u32,
    /// Number of stash entries.
    pub stashed: u32,
    pub error: Option<String>,
}

impl ProjectStatus {
    pub(crate) fn bare(target: &ProjectTarget, name: String, kind: &'static str) -> Self {
        Self {
            path: target.path.clone(),
            name,
            workspace: target.workspace.clone(),
            kind,
            branch: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            detached: false,
            dirty: 0,
            stashed: 0,
            error: None,
        }
    }
}