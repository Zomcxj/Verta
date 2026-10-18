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
    pub fn failed_after(kind: &'static str, error: impl Into<String>, repos: Vec<RemoteRepo>) -> Self {
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

#[cfg(test)]
mod tests {
    use super::*;

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