//! 「远程仓库列表」命令：借本机已登录的 gh CLI 取当前账号能访问的仓库。
//!
//! 现在有两片：仓库列表（`github_repos`）与单个仓库的 CI 状态（`github_repo_ci`）。
//! Releases / Actions 明细 / 下载留给后续切片。gh 是账号级的东西，一律在主机环境跑，
//! 与当前空间 / 发行版无关。纯逻辑放在 `repos.rs` / `ci.rs`，这里只做编排。

use crate::modules::fs::blocking;

use super::ci::parse_latest_run;
use super::ci::parse_repo_slug;
use super::gh::{self, GhRunError, LoginProbe};
use super::repos::{
    classify_failure, error_excerpt, page_path, parse_login, parse_repos, should_continue_page,
    MAX_PAGES, MAX_PER_PAGE,
};
use super::types::{RemoteRepo, RemoteReposPayload, RepoCiPayload, KIND_ERROR};

/// 当前账号能访问的仓库列表（自己的 + 协作的 + 组织成员可见的）。
///
/// `limit` 是**每页条数**的上限，clamp 到 1..=100，默认 100；总条数由翻页上限决定。
#[tauri::command]
pub async fn github_repos(limit: Option<usize>) -> Result<RemoteReposPayload, String> {
    // 起 gh 进程是阻塞活，扔到 blocking pool，别占 async worker。
    blocking(move || Ok(list_repos(limit))).await
}

fn list_repos(limit: Option<usize>) -> RemoteReposPayload {
    let per_page = limit.unwrap_or(MAX_PER_PAGE).clamp(1, MAX_PER_PAGE);

    // 先用一次 `gh api user` 确认「gh 能不能跑 / 登没登录」，顺便拿登录名。
    let login = match gh::run(&["api", "user", "--jq", ".login"], gh::USER_TIMEOUT_SECS) {
        Ok(output) => match gh::probe_login(&output) {
            LoginProbe::Login(login) => login,
            LoginProbe::Failed(failure, message) => {
                return RemoteReposPayload::failed(failure.kind(), message)
            }
        },
        Err(GhRunError::NotInstalled) => return RemoteReposPayload::not_installed(),
        Err(GhRunError::Io(error)) => {
            return RemoteReposPayload::failed(KIND_ERROR, format!("运行 gh 失败：{error}"))
        }
    };

    // 显示名字只是顺带的：拿不到就当没有，不影响列表。
    let account_name = gh::run(&["api", "user", "--jq", ".name"], gh::USER_TIMEOUT_SECS)
        .ok()
        .filter(|output| output.is_ok())
        .and_then(|output| parse_login(&output.stdout));

    let mut repos: Vec<RemoteRepo> = Vec::new();
    let mut truncated = false;

    for page in 1..=MAX_PAGES {
        let path = page_path(page, per_page);
        let output = match gh::run(&["api", &path], gh::REPOS_TIMEOUT_SECS) {
            Ok(output) => output,
            Err(GhRunError::NotInstalled) => return RemoteReposPayload::not_installed(),
            Err(GhRunError::Io(error)) => {
                return RemoteReposPayload::failed_after(
                    KIND_ERROR,
                    format!("运行 gh 失败：{error}"),
                    repos,
                )
            }
        };

        if !output.is_ok() {
            // 翻页中途失败也照实报：已经拿到的仓库带回去，但 kind 不能是 ready。
            let text = output.failure_text();
            return RemoteReposPayload::failed_after(
                classify_failure(&text).kind(),
                error_excerpt(&text),
                repos,
            );
        }

        let page_repos = match parse_repos(&output.stdout) {
            Ok(rows) => rows,
            Err(error) => {
                return RemoteReposPayload::failed_after(
                    KIND_ERROR,
                    format!("gh 返回的仓库列表无法解析：{error}"),
                    repos,
                )
            }
        };

        let count = page_repos.len();
        repos.extend(page_repos);
        // 不满一页就是最后一页；满页继续翻，直到页数上限。
        if !should_continue_page(count, per_page) {
            break;
        }
        if page == MAX_PAGES {
            // 停在上限且最后一页是满页：后面多半还有，如实标记。
            truncated = true;
        }
    }

    RemoteReposPayload::ready(login, account_name, repos, truncated)
}

/// 某个仓库最近一次 CI 运行。
///
/// 由界面按需触发（一次一个仓库）：列表里每个仓库都去查会把 API 配额烧光。
#[tauri::command]
pub async fn github_repo_ci(repo: String) -> Result<RepoCiPayload, String> {
    blocking(move || Ok(read_repo_ci(&repo))).await
}

fn read_repo_ci(repo: &str) -> RepoCiPayload {
    let slug = match parse_repo_slug(repo) {
        Ok(slug) => slug,
        // 名字本身不合法：照实说，不用去问 gh。
        Err(message) => return RepoCiPayload::failed(KIND_ERROR, repo.trim(), message),
    };

    let path = format!("repos/{slug}/actions/runs?per_page=1");
    let output = match gh::run(&["api", &path], gh::CI_TIMEOUT_SECS) {
        Ok(output) => output,
        Err(GhRunError::NotInstalled) => return RepoCiPayload::not_installed(&slug),
        Err(GhRunError::Io(error)) => {
            return RepoCiPayload::failed(KIND_ERROR, &slug, format!("运行 gh 失败：{error}"))
        }
    };

    if !output.is_ok() {
        let text = output.failure_text();
        return RepoCiPayload::failed(classify_failure(&text).kind(), &slug, error_excerpt(&text));
    }

    match parse_latest_run(&output.stdout) {
        Ok(Some(run)) => RepoCiPayload::found(&slug, run),
        // 查清楚了：这个仓库没有运行记录。
        Ok(None) => RepoCiPayload::empty(&slug),
        Err(error) => RepoCiPayload::failed(
            KIND_ERROR,
            &slug,
            format!("gh 返回的运行记录无法解析：{error}"),
        ),
    }
}
