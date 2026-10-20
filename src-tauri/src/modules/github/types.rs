//! 远程仓库列表的 wire 结构。字段名前端已经按这个调用，改名等于改契约。

use serde::Serialize;

/// 查询成功的 `kind`。
pub const KIND_READY: &str = "ready";
/// 本机没有 gh CLI。
pub const KIND_NOT_INSTALLED: &str = "notInstalled";
/// 装了 gh，但当前账号没登录 / 凭据失效。
pub const KIND_NOT_LOGGED_IN: &str = "notLoggedIn";
/// 其它失败（网络、限流、解析不了）。
pub const KIND_ERROR: &str = "error";
/// 仓库里没有任何 workflow 运行（要么没配 CI，要么还没跑过）。
///
/// 这不是失败：查得清清楚楚「没有」，所以单独一类，界面说「没有 CI」而不是报错。
pub const KIND_NONE: &str = "none";

/// gh 没有给出任何可展示的原文时的兜底，免得前端拿到空字符串。
const NO_DETAIL: &str = "gh 没有给出错误输出";

/// 一次「远程仓库列表」查询的结果。
///
/// `kind` 说明这次查到了什么：
/// - `ready`：查询成功（`repos` 可能就是空数组，那是真的没有仓库）；
/// - `notInstalled` / `notLoggedIn` / `error`：失败，原因在 `error` 里如实带出来，
///   绝不伪装成空列表。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteReposPayload {
    pub kind: &'static str,
    /// 已登录时的用户名。
    pub login: Option<String>,
    /// `gh api user` 里的 `name`，可能为空。
    pub account_name: Option<String>,
    pub repos: Vec<RemoteRepo>,
    /// 翻到页数上限，且最后一页仍是满页：后面多半还有仓库没取。
    pub truncated: bool,
    /// `kind` 非 `ready` 时的原文（gh 的 stderr / stdout 前几行）。
    pub error: Option<String>,
}

/// 一个远程仓库。只带列表要展示的字段，细节（Releases / Actions）留给后续切片。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRepo {
    /// `owner/name`。
    pub full_name: String,
    pub owner: String,
    pub name: String,
    pub is_private: bool,
    pub is_fork: bool,
    pub is_archived: bool,
    pub language: Option<String>,
    /// 原样带上 GitHub 的 ISO8601，相对时间由前端自己转。
    pub pushed_at: Option<String>,
    pub description: Option<String>,
    /// `https://github.com/owner/name`。
    pub web_url: String,
}

impl RemoteReposPayload {
    pub fn ready(
        login: String,
        account_name: Option<String>,
        repos: Vec<RemoteRepo>,
        truncated: bool,
    ) -> Self {
        Self {
            kind: KIND_READY,
            login: Some(login),
            account_name,
            repos,
            truncated,
            error: None,
        }
    }

    /// 失败：`repos` 为空，`error` 必须有内容（空的话给兜底文案，别让前端显示空白）。
    pub fn failed(kind: &'static str, error: impl Into<String>) -> Self {
        Self::failed_after(kind, error, Vec::new())
    }

    /// 翻页中途失败：已经拿到的仓库照样带回去，不白扔。`kind` 已经不是 `ready`，
    /// 前端不会把它当成一份完整列表。
    pub fn failed_after(
        kind: &'static str,
        error: impl Into<String>,
        repos: Vec<RemoteRepo>,
    ) -> Self {
        let error = error.into();
        let error = if error.trim().is_empty() {
            NO_DETAIL.to_string()
        } else {
            error
        };
        Self {
            kind,
            login: None,
            account_name: None,
            repos,
            truncated: false,
            error: Some(error),
        }
    }

    pub fn not_installed() -> Self {
        Self::failed(KIND_NOT_INSTALLED, "未安装 gh CLI（找不到 gh 命令）")
    }
}

/// 一个仓库最近一次 workflow 运行。只带界面要展示与要跳转的字段。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoCiRun {
    /// workflow 名字（`build`、`CI` 之类）。
    pub name: String,
    /// `queued` / `in_progress` / `completed` 等，GitHub 原样给的值。
    pub status: String,
    /// `success` / `failure` / `cancelled` 等；还没跑完时为空。
    pub conclusion: Option<String>,
    pub run_number: u64,
    pub head_branch: Option<String>,
    /// ISO8601，相对时间由前端自己转。
    pub updated_at: Option<String>,
    pub url: String,
}

/// 单个仓库的 CI 查询结果。`kind` 与仓库列表同一套语义，另加 `none`（没有运行记录）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoCiPayload {
    pub kind: &'static str,
    /// 查的是哪个仓库（`owner/name`），前端按它把结果放回对应行。
    pub repo: String,
    pub run: Option<RepoCiRun>,
    pub error: Option<String>,
}

impl RepoCiPayload {
    pub fn found(repo: impl Into<String>, run: RepoCiRun) -> Self {
        Self {
            kind: KIND_READY,
            repo: repo.into(),
            run: Some(run),
            error: None,
        }
    }

    pub fn empty(repo: impl Into<String>) -> Self {
        Self {
            kind: KIND_NONE,
            repo: repo.into(),
            run: None,
            error: None,
        }
    }

    pub fn failed(kind: &'static str, repo: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            kind,
            repo: repo.into(),
            run: None,
            error: Some(or_no_detail(error.into())),
        }
    }

    pub fn not_installed(repo: impl Into<String>) -> Self {
        Self::failed(KIND_NOT_INSTALLED, repo, "未安装 gh CLI（找不到 gh 命令）")
    }
}

/// 兜底文案：gh 没给出可展示的原文时用它，免得前端拿到空字符串。
fn or_no_detail(error: String) -> String {
    if error.trim().is_empty() {
        NO_DETAIL.to_string()
    } else {
        error
    }
}

/// 一条 workflow 运行（运行列表里的一行）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoActionRun {
    /// GitHub 那边的运行 id：重跑/取消要原样带回去。
    pub id: u64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub run_number: u64,
    pub head_branch: Option<String>,
    /// `push` / `pull_request` / `workflow_dispatch` 等，GitHub 原样给的值。
    pub event: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub url: String,
}

/// 某个仓库的运行列表。`kind` 与 CI 那条同一套语义（`none` 是「确实没有运行记录」）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoActionRunsPayload {
    pub kind: &'static str,
    pub repo: String,
    pub runs: Vec<RepoActionRun>,
    pub error: Option<String>,
}

impl RepoActionRunsPayload {
    /// 查到了。空列表归 `none`（真没有运行记录），不归 `ready` —— 与 CI 那条一致。
    pub fn found(repo: impl Into<String>, runs: Vec<RepoActionRun>) -> Self {
        if runs.is_empty() {
            return Self::empty(repo);
        }
        Self {
            kind: KIND_READY,
            repo: repo.into(),
            runs,
            error: None,
        }
    }

    pub fn empty(repo: impl Into<String>) -> Self {
        Self {
            kind: KIND_NONE,
            repo: repo.into(),
            runs: Vec::new(),
            error: None,
        }
    }

    pub fn failed(kind: &'static str, repo: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            kind,
            repo: repo.into(),
            runs: Vec::new(),
            error: Some(or_no_detail(error.into())),
        }
    }

    pub fn not_installed(repo: impl Into<String>) -> Self {
        Self::failed(KIND_NOT_INSTALLED, repo, "未安装 gh CLI（找不到 gh 命令）")
    }
}

/// 重跑 / 取消的结果。
///
/// 成功不带数据（gh 成功时也没什么有用的输出），失败把 gh 原文照实带回去 —— 比如对一次
/// 已经跑完的运行点取消，GitHub 会拒绝，那句话就是用户需要看到的东西。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRunActionResult {
    pub kind: &'static str,
    pub repo: String,
    pub run_id: u64,
    pub error: Option<String>,
}

impl RepoRunActionResult {
    pub fn ok(repo: impl Into<String>, run_id: u64) -> Self {
        Self {
            kind: KIND_READY,
            repo: repo.into(),
            run_id,
            error: None,
        }
    }

    pub fn failed(
        kind: &'static str,
        repo: impl Into<String>,
        run_id: u64,
        error: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            repo: repo.into(),
            run_id,
            error: Some(or_no_detail(error.into())),
        }
    }

    pub fn not_installed(repo: impl Into<String>, run_id: u64) -> Self {
        Self::failed(
            KIND_NOT_INSTALLED,
            repo,
            run_id,
            "未安装 gh CLI（找不到 gh 命令）",
        )
    }
}

/// 运行详情里的一个步骤。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoRunStep {
    pub number: u64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
}

/// 运行详情里的一个 job（含它的步骤树）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoRunJob {
    pub id: u64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub url: Option<String>,
    /// 跑在哪个 runner 上；GitHub 没给 runner 名时用第一个 label 兜底。
    pub runner: Option<String>,
    pub steps: Vec<RepoRunStep>,
}

/// 一次运行的 job 列表。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRunJobsPayload {
    pub kind: &'static str,
    pub repo: String,
    pub run_id: u64,
    pub jobs: Vec<RepoRunJob>,
    pub error: Option<String>,
}

impl RepoRunJobsPayload {
    pub fn found(repo: impl Into<String>, run_id: u64, jobs: Vec<RepoRunJob>) -> Self {
        Self {
            kind: KIND_READY,
            repo: repo.into(),
            run_id,
            jobs,
            error: None,
        }
    }

    /// 一个 job 都没有（还在排队、或工作流本来就没有任务）：查清楚了的「没有」。
    pub fn empty(repo: impl Into<String>, run_id: u64) -> Self {
        Self {
            kind: KIND_NONE,
            repo: repo.into(),
            run_id,
            jobs: Vec::new(),
            error: None,
        }
    }

    pub fn failed(
        kind: &'static str,
        repo: impl Into<String>,
        run_id: u64,
        error: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            repo: repo.into(),
            run_id,
            jobs: Vec::new(),
            error: Some(or_no_detail(error.into())),
        }
    }

    pub fn not_installed(repo: impl Into<String>, run_id: u64) -> Self {
        Self::failed(
            KIND_NOT_INSTALLED,
            repo,
            run_id,
            "未安装 gh CLI（找不到 gh 命令）",
        )
    }
}

/// 日志里的一行：前缀拆成 job / step / 时间，正文单独放。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoRunLogLine {
    pub job: String,
    pub step: String,
    /// ISO8601（GitHub 给的是带小数秒的 UTC）；认不出来时为空。
    pub time: String,
    pub text: String,
}

/// 一次运行的日志。
///
/// `clipped` 与 `capped` 是两件事，界面上说法也不同：`clipped` 是我们只留了尾部（日志本来更
/// 长），`capped` 是一次能取的上限就被撑满了（拿到的是开头那一段，后面还有）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRunLogPayload {
    pub kind: &'static str,
    pub repo: String,
    pub run_id: u64,
    pub lines: Vec<RepoRunLogLine>,
    /// 截断前一共多少行。
    pub total_lines: usize,
    pub clipped: bool,
    pub capped: bool,
    pub error: Option<String>,
}

impl RepoRunLogPayload {
    pub fn found(
        repo: impl Into<String>,
        run_id: u64,
        lines: Vec<RepoRunLogLine>,
        total_lines: usize,
        clipped: bool,
        capped: bool,
    ) -> Self {
        Self {
            kind: KIND_READY,
            repo: repo.into(),
            run_id,
            lines,
            total_lines,
            clipped,
            capped,
            error: None,
        }
    }

    pub fn failed(
        kind: &'static str,
        repo: impl Into<String>,
        run_id: u64,
        error: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            repo: repo.into(),
            run_id,
            lines: Vec::new(),
            total_lines: 0,
            clipped: false,
            capped: false,
            error: Some(or_no_detail(error.into())),
        }
    }

    pub fn not_installed(repo: impl Into<String>, run_id: u64) -> Self {
        Self::failed(
            KIND_NOT_INSTALLED,
            repo,
            run_id,
            "未安装 gh CLI（找不到 gh 命令）",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ci_payload_never_carries_a_blank_error_or_a_blank_repo() {
        let payload = RepoCiPayload::failed(KIND_ERROR, "a/b", "   ");
        assert_eq!(payload.kind, KIND_ERROR);
        assert_eq!(payload.repo, "a/b");
        assert_eq!(payload.error.as_deref(), Some(NO_DETAIL));
        assert!(payload.run.is_none());
    }

    #[test]
    fn an_empty_ci_answer_is_not_an_error() {
        let payload = RepoCiPayload::empty("a/b");
        assert_eq!(payload.kind, KIND_NONE);
        assert!(payload.run.is_none());
        assert!(payload.error.is_none());
    }

    #[test]
    fn failed_payload_never_carries_a_blank_error() {
        let payload = RemoteReposPayload::failed(KIND_ERROR, "  ");
        assert_eq!(payload.kind, KIND_ERROR);
        assert!(payload.repos.is_empty());
        assert_eq!(payload.error.as_deref(), Some(NO_DETAIL));

        let payload = RemoteReposPayload::not_installed();
        assert_eq!(payload.kind, KIND_NOT_INSTALLED);
        assert!(payload.login.is_none());
        assert!(payload.error.is_some());
    }

    #[test]
    fn ready_payload_keeps_an_empty_list_distinct_from_failure() {
        let payload = RemoteReposPayload::ready("Zomcxj".into(), None, Vec::new(), false);
        assert_eq!(payload.kind, KIND_READY);
        assert_eq!(payload.login.as_deref(), Some("Zomcxj"));
        assert!(payload.error.is_none());
        assert!(payload.repos.is_empty());
    }
}
