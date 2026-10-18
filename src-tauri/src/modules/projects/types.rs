use serde::{Deserialize, Serialize};

use crate::modules::workspace::WorkspaceEnv;

/// 前端要查状态的一个项目。环境随请求走：同一个列表里可能混着本机与发行版里的项目，
/// 状态必须在项目所在的那一侧去取。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTarget {
    pub path: String,
    #[serde(default)]
    pub workspace: WorkspaceEnv,
}

/// 一个项目的状态。`kind` 说明这次查到了什么，其余字段按它的含义填：
///
/// - `repo`：真的是 git 仓库，后面各字段有效；
/// - `notRepo`：路径在，但它（以及所有上级）不在仓库里；
/// - `missing`：路径不存在（盘拔了、目录改名、发行版没开）；
/// - `error`：其它失败，原因在 `error` 里如实带出来，不伪装成「干净」。
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
    /// 未提交的文件数（含未跟踪）。
    pub dirty: u32,
    /// 储藏条数。
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