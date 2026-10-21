//! GitHub 面板的命令：借本机已登录的 gh CLI 取仓库、CI 状态、运行列表与详情、Release，
//! 并能重跑 / 取消 / 删除一次运行、把 Release 附件下载到用户选的目录。
//!
//! gh 是账号级的东西，一律在主机环境跑，与当前空间 / 发行版无关。纯逻辑放在
//! `repos.rs` / `ci.rs` / `actions.rs` / `releases.rs`，这里只做编排。

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, State};

use crate::modules::fs::blocking;
use crate::modules::proc::hide_console;

use super::actions::{
    cap_lines, clamp_limit, classify_run_probe, parse_jobs, parse_log, parse_runs, RunProbe,
    MAX_LOG_LINES,
};
use super::auth;
use super::ci::parse_latest_run;
use super::ci::parse_repo_slug;
use super::gh::{self, GhRunError, LoginProbe};
use super::issues;
use super::permission;
pub use super::releases::DownloadState;
use super::releases::{self, finish_download, safe_file_name, should_report};
use super::repo_admin;
use super::repos::{
    classify_failure, error_excerpt, page_path, parse_login, parse_repos, should_continue_page,
    Failure, MAX_PAGES, MAX_PER_PAGE,
};
use super::types::{
    AuthActionPayload, AuthLoginProgress, AuthStatusPayload, IssueActionResult, IssueDetailPayload,
    IssueListPayload, ReleaseDownloadProgress, ReleaseDownloadResult, RemoteRepo,
    RemoteReposPayload, RepoActionRunsPayload, RepoActionResult, RepoCiPayload,
    RepoPermissionPayload, RepoReleasesPayload, RepoRunActionResult, RepoRunJobsPayload,
    RepoRunLogPayload, RepoSettingsPayload, KIND_ERROR,
};

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

/// 某个仓库的当前账号权限，界面据此决定写操作按钮在不在。
///
/// 与 CI 状态一样由界面按需触发（一次一个仓库）：列表里每个仓库都去查会把 API 配额烧光。
#[tauri::command]
pub async fn github_repo_permission(repo: String) -> Result<RepoPermissionPayload, String> {
    blocking(move || Ok(read_repo_permission(&repo))).await
}

fn read_repo_permission(repo: &str) -> RepoPermissionPayload {
    let slug = match parse_repo_slug(repo) {
        Ok(slug) => slug,
        // 名字本身不合法：照实说，不用去问 gh。
        Err(message) => return RepoPermissionPayload::failed(KIND_ERROR, repo.trim(), message),
    };

    let output = match gh::run(
        &[
            "repo",
            "view",
            &slug,
            "--json",
            "viewerPermission",
            "--jq",
            ".viewerPermission",
        ],
        gh::PERMISSION_TIMEOUT_SECS,
    ) {
        Ok(output) => output,
        Err(GhRunError::NotInstalled) => return RepoPermissionPayload::not_installed(&slug),
        Err(GhRunError::Io(error)) => {
            return RepoPermissionPayload::failed(
                KIND_ERROR,
                &slug,
                format!("运行 gh 失败：{error}"),
            )
        }
    };

    if !output.is_ok() {
        let text = output.failure_text();
        return RepoPermissionPayload::failed(
            classify_failure(&text).kind(),
            &slug,
            error_excerpt(&text),
        );
    }

    // 拿不到权限名（输出是空的）走「按有权限渲染」，不拦用户。
    let permission = permission::parse_permission(&output.stdout);
    let can_write = permission::write_allowed(permission.as_deref());
    RepoPermissionPayload::found(&slug, permission, can_write)
}

/// 仓库管理面板要的那几样：描述、可见性，以及当前账号能不能改。
///
/// 与权限查询同源（同一条 `gh repo view`），所以两个弹窗各查各的、不共用缓存。
#[tauri::command]
pub async fn github_repo_settings(repo: String) -> Result<RepoSettingsPayload, String> {
    blocking(move || Ok(read_repo_settings(&repo))).await
}

fn read_repo_settings(repo: &str) -> RepoSettingsPayload {
    let slug = match parse_repo_slug(repo) {
        Ok(slug) => slug,
        Err(message) => return RepoSettingsPayload::failed(KIND_ERROR, repo.trim(), message),
    };

    let output = match gh::run(
        &[
            "repo",
            "view",
            &slug,
            "--json",
            "description,visibility,viewerPermission",
        ],
        gh::PERMISSION_TIMEOUT_SECS,
    ) {
        Ok(output) => output,
        Err(GhRunError::NotInstalled) => return RepoSettingsPayload::not_installed(&slug),
        Err(GhRunError::Io(error)) => {
            return RepoSettingsPayload::failed(
                KIND_ERROR,
                &slug,
                format!("运行 gh 失败：{error}"),
            )
        }
    };

    if !output.is_ok() {
        let text = output.failure_text();
        return RepoSettingsPayload::failed(
            classify_failure(&text).kind(),
            &slug,
            error_excerpt(&text),
        );
    }

    match repo_admin::parse_settings(&output.stdout) {
        Ok(settings) => RepoSettingsPayload::found(&slug, settings),
        Err(error) => RepoSettingsPayload::failed(KIND_ERROR, &slug, error),
    }
}

/// 改仓库描述；传空串就是清空。
#[tauri::command]
pub async fn github_repo_set_description(
    repo: String,
    description: String,
) -> Result<RepoActionResult, String> {
    blocking(move || Ok(repo_admin(&repo, RepoAdmin::Description(description)))).await
}

/// 切可见性。`private` 为 true 是私有；切公开前界面已经让用户明确接受了后果。
#[tauri::command]
pub async fn github_repo_set_visibility(
    repo: String,
    private: bool,
) -> Result<RepoActionResult, String> {
    blocking(move || Ok(repo_admin(&repo, RepoAdmin::Visibility(private)))).await
}

/// 删仓库。不可撤销：发完请求还要回查确认它真的没了才报成功。
#[tauri::command]
pub async fn github_repo_delete(repo: String) -> Result<RepoActionResult, String> {
    blocking(move || Ok(repo_admin(&repo, RepoAdmin::Delete))).await
}

enum RepoAdmin {
    Description(String),
    Visibility(bool),
    Delete,
}

fn repo_admin(repo: &str, action: RepoAdmin) -> RepoActionResult {
    let slug = match parse_repo_slug(repo) {
        Ok(slug) => slug,
        Err(message) => return RepoActionResult::failed(KIND_ERROR, repo.trim(), message),
    };

    // 超长的描述 GitHub 一定拒，先在本地说清楚，别白跑一趟。
    if let RepoAdmin::Description(text) = &action {
        if let Some(problem) = repo_admin::description_problem(text) {
            return RepoActionResult::failed(KIND_ERROR, &slug, problem);
        }
    }

    let args: Vec<&str> = match &action {
        RepoAdmin::Description(text) => {
            vec!["repo", "edit", &slug, "--description", text.trim()]
        }
        RepoAdmin::Visibility(private) => vec![
            "repo",
            "edit",
            &slug,
            "--visibility",
            if *private { "private" } else { "public" },
            // gh 要求显式接受可见性变更的后果；界面上那句确认就是这个意思。
            "--accept-visibility-change-consequences",
        ],
        RepoAdmin::Delete => vec!["repo", "delete", &slug, "--yes"],
    };

    let output = match gh::run(&args, gh::REPO_ADMIN_TIMEOUT_SECS) {
        Ok(output) => output,
        Err(GhRunError::NotInstalled) => return RepoActionResult::not_installed(&slug),
        Err(GhRunError::Io(error)) => {
            return RepoActionResult::failed(
                KIND_ERROR,
                &slug,
                format!("运行 gh 失败：{error}"),
            )
        }
    };

    if !output.is_ok() {
        let text = output.failure_text();
        let detail = error_excerpt(&text);
        // 缺 delete_repo 授权是能自己补救的失败：把该跑的命令直接写在话里。
        if matches!(action, RepoAdmin::Delete) && repo_admin::needs_delete_scope(&text) {
            return RepoActionResult::failed(
                KIND_ERROR,
                &slug,
                format!(
                    "gh 缺少 delete_repo 授权：在终端跑 `gh auth refresh -s delete_repo` \
                     完成一次浏览器确认后重试。GitHub 原话：{detail}"
                ),
            );
        }
        return RepoActionResult::failed(classify_failure(&text).kind(), &slug, detail);
    }

    // 删除不可撤销：请求发出去还不算数，回查确认它真的没了才报成功。
    if matches!(action, RepoAdmin::Delete) {
        return confirm_repo_gone(&slug);
    }
    RepoActionResult::ok(&slug)
}

/// 回查仓库是否真的没了：`gh api repos/{slug}` 明确 404 才算删掉。
fn confirm_repo_gone(slug: &str) -> RepoActionResult {
    let path = format!("repos/{slug}");
    // 与删运行同一套：GitHub 是即刻生效的，万一慢半拍就再看一眼。
    for attempt in 0..2 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(800));
        }
        match gh::run(&["api", &path], gh::CI_TIMEOUT_SECS) {
            Ok(output) => {
                let text = output.failure_text();
                match classify_run_probe(output.is_ok(), &text) {
                    RunProbe::Gone => return RepoActionResult::ok(slug),
                    RunProbe::Present if attempt == 0 => continue,
                    RunProbe::Present => {
                        return RepoActionResult::failed(
                            KIND_ERROR,
                            slug,
                            "gh 报告删除成功，但这个仓库在 GitHub 上还在（可能没删掉）",
                        )
                    }
                    RunProbe::Unknown if attempt == 0 => continue,
                    RunProbe::Unknown => {
                        return RepoActionResult::failed(
                            KIND_ERROR,
                            slug,
                            format!("删除请求已发出，但没能确认结果：{}", error_excerpt(&text)),
                        )
                    }
                }
            }
            Err(GhRunError::NotInstalled) => {
                return RepoActionResult::failed(
                    KIND_ERROR,
                    slug,
                    "删除请求已发出，但回查时找不到 gh 命令，没能确认结果",
                )
            }
            Err(GhRunError::Io(error)) => {
                return RepoActionResult::failed(
                    KIND_ERROR,
                    slug,
                    format!("删除请求已发出，但回查失败：{error}"),
                )
            }
        }
    }
    RepoActionResult::failed(KIND_ERROR, slug, "删除请求已发出，但没能确认结果")
}

/// 本机 gh 的登录态。
#[tauri::command]
pub async fn github_auth_status() -> Result<AuthStatusPayload, String> {
    blocking(move || Ok(read_auth_status())).await
}

fn read_auth_status() -> AuthStatusPayload {
    let output = match gh::run(&["auth", "status", "--json", "hosts"], gh::USER_TIMEOUT_SECS) {
        Ok(output) => output,
        Err(GhRunError::NotInstalled) => return AuthStatusPayload::not_installed(),
        Err(GhRunError::Io(error)) => {
            return AuthStatusPayload::failed(format!("运行 gh 失败：{error}"))
        }
    };

    match auth::parse_status(&output.stdout) {
        Ok(Some(account)) => AuthStatusPayload::found(account),
        // 查清楚了：一个 host 都没登。这是 `none`，不是错误。
        Ok(None) => AuthStatusPayload::none(),
        Err(error) => {
            let text = output.failure_text();
            // 老版本 gh 没有 --json，或者输出被别的东西污染：退回按文本判定登录态。
            if !output.is_ok() && matches!(classify_failure(&text), Failure::NotLoggedIn) {
                AuthStatusPayload::none()
            } else {
                AuthStatusPayload::failed(format!(
                    "{error}（gh 原话：{}）",
                    error_excerpt(&text)
                ))
            }
        }
    }
}

/// 用粘贴的 PAT 登录。token 只经过内存：写进 gh 的 stdin，不落任何存储。
#[tauri::command]
pub async fn github_auth_login_token(token: String) -> Result<AuthActionPayload, String> {
    blocking(move || Ok(login_with_token(&token))).await
}

fn login_with_token(token: &str) -> AuthActionPayload {
    if let Some(problem) = auth::token_problem(token) {
        return AuthActionPayload::failed(problem);
    }
    let result = gh::run_with_stdin(
        &[
            "auth",
            "login",
            "--hostname",
            "github.com",
            "--git-protocol",
            "https",
            "--with-token",
        ],
        token.trim(),
        gh::AUTH_TOKEN_TIMEOUT_SECS,
    );
    match result {
        Ok(output) if output.is_ok() => AuthActionPayload::ok(None),
        Ok(output) => {
            let text = output.failure_text();
            AuthActionPayload::failed(format!("gh 没接受这个 token：{}", error_excerpt(&text)))
        }
        Err(GhRunError::NotInstalled) => AuthActionPayload::not_installed(),
        Err(GhRunError::Io(error)) => {
            AuthActionPayload::failed(format!("运行 gh 失败：{error}"))
        }
    }
}

/// 浏览器授权：跑 `gh auth login --web`，把它打出来的话（含一次性码）实时推给界面。
///
/// 这一步要人在浏览器里点，所以超时给到十分钟；中途可以取消。
#[tauri::command]
pub async fn github_auth_login_web(
    app: AppHandle,
    state: State<'_, AuthLoginState>,
) -> Result<AuthActionPayload, String> {
    let worker_app = app.clone();
    // 把状态抄一份出来（内部是 Arc）：blocking 闭包要带着它活到后台线程上。
    let worker_state = state.inner().clone();
    blocking(move || Ok(login_with_web(&worker_app, &worker_state))).await
}

#[tauri::command]
pub fn github_auth_login_web_cancel(state: State<'_, AuthLoginState>) {
    state.cancel();
}

fn login_with_web(app: &AppHandle, state: &AuthLoginState) -> AuthActionPayload {
    let child = match gh::spawn(
        &[
            "auth",
            "login",
            "--hostname",
            "github.com",
            "--git-protocol",
            "https",
            "--web",
        ],
        // 交互提示不关：这一条本来就要开浏览器、要等人在浏览器里点完。
        false,
    ) {
        Ok(child) => std::sync::Arc::new(child),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
            ) =>
        {
            return AuthActionPayload::not_installed()
        }
        Err(error) => return AuthActionPayload::failed(format!("无法启动 gh：{error}")),
    };
    state.set(child.clone());

    let sink = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    // 两个管道各起一个读线程：gh 把一次性码打在 stderr 上，别漏了。
    if let Some(pipe) = child.take_stdout() {
        let sink = sink.clone();
        let app = app.clone();
        gh::pump(pipe, move |text| emit_auth_text(&sink, &app, text));
    }
    if let Some(pipe) = child.take_stderr() {
        let sink = sink.clone();
        let app = app.clone();
        gh::pump(pipe, move |text| emit_auth_text(&sink, &app, text));
    }

    let deadline = Instant::now() + Duration::from_secs(gh::AUTH_WEB_TIMEOUT_SECS);
    let mut cancelled = false;
    let status = loop {
        if state.is_cancelled() {
            cancelled = true;
            break None;
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(error) => return AuthActionPayload::failed(format!("等待 gh 失败：{error}")),
        }
    };
    state.clear();
    // 让读线程把管道里的尾巴收完。
    std::thread::sleep(Duration::from_millis(300));

    let output = sink
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    if cancelled {
        return AuthActionPayload::cancelled(Some(output));
    }
    match status {
        Some(status) if status.success() => AuthActionPayload::ok(Some(output)),
        Some(_) => AuthActionPayload::failed(format!(
            "浏览器授权没成功。gh 说：{}",
            last_lines(&output, 3)
        )),
        None => AuthActionPayload::failed(format!(
            "等了 {} 分钟还没在浏览器里完成，已中止。gh 说：{}",
            gh::AUTH_WEB_TIMEOUT_SECS / 60,
            last_lines(&output, 3)
        )),
    }
}

/// 登出。界面上要求确认过才发这条。
#[tauri::command]
pub async fn github_auth_logout(login: Option<String>) -> Result<AuthActionPayload, String> {
    blocking(move || Ok(logout(login.as_deref()))).await
}

fn logout(login: Option<&str>) -> AuthActionPayload {
    let mut args = vec!["auth", "logout", "--hostname", "github.com"];
    let user = login.map(str::trim).filter(|value| !value.is_empty());
    if let Some(user) = user {
        args.push("--user");
        args.push(user);
    }
    match gh::run(&args, gh::USER_TIMEOUT_SECS) {
        Ok(output) if output.is_ok() => AuthActionPayload::ok(Some(output.stdout.clone())),
        Ok(output) => {
            let text = output.failure_text();
            AuthActionPayload::failed(format!("登出没成功：{}", error_excerpt(&text)))
        }
        Err(GhRunError::NotInstalled) => AuthActionPayload::not_installed(),
        Err(GhRunError::Io(error)) => {
            AuthActionPayload::failed(format!("运行 gh 失败：{error}"))
        }
    }
}

/// 浏览器授权时把 gh 的一段输出同时记进汇总、并推给界面。
fn emit_auth_text(
    sink: &std::sync::Arc<std::sync::Mutex<String>>,
    app: &AppHandle,
    text: &str,
) {
    if let Ok(mut guard) = sink.lock() {
        guard.push_str(text);
    }
    let _ = app.emit(
        "verta://gh-auth",
        AuthLoginProgress {
            text: text.to_string(),
        },
    );
}

/// gh 打出来的最后几行：给失败原因用，别把整段甩给用户。
fn last_lines(text: &str, count: usize) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let start = lines.len().saturating_sub(count);
    lines[start..].join(" / ")
}

/// 浏览器授权那个 gh 进程的把手（取消要用）。
#[derive(Default, Clone)]
pub struct AuthLoginState {
    child: std::sync::Arc<std::sync::Mutex<Option<std::sync::Arc<shared_child::SharedChild>>>>,
    cancelled: std::sync::Arc<AtomicBool>,
}

impl AuthLoginState {
    fn set(&self, child: std::sync::Arc<shared_child::SharedChild>) {
        self.cancelled.store(false, Ordering::SeqCst);
        if let Ok(mut guard) = self.child.lock() {
            *guard = Some(child);
        }
    }

    fn clear(&self) {
        if let Ok(mut guard) = self.child.lock() {
            *guard = None;
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// 取消一次浏览器授权：标记 + 杀掉那个 gh 进程。
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.child.lock() {
            if let Some(child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// 某个仓库最近的运行列表。
///
/// 与 CI 状态一样由界面按需触发：`limit` 是这次要几条（夹到 1..=50，默认 20）。
#[tauri::command]
pub async fn github_repo_runs(
    repo: String,
    limit: Option<usize>,
) -> Result<RepoActionRunsPayload, String> {
    blocking(move || Ok(read_repo_runs(&repo, limit))).await
}

fn read_repo_runs(repo: &str, limit: Option<usize>) -> RepoActionRunsPayload {
    let slug = match parse_repo_slug(repo) {
        Ok(slug) => slug,
        Err(message) => return RepoActionRunsPayload::failed(KIND_ERROR, repo.trim(), message),
    };

    let per_page = clamp_limit(limit);
    let path = format!("repos/{slug}/actions/runs?per_page={per_page}");
    let output = match gh::run(&["api", &path], gh::CI_TIMEOUT_SECS) {
        Ok(output) => output,
        Err(GhRunError::NotInstalled) => return RepoActionRunsPayload::not_installed(&slug),
        Err(GhRunError::Io(error)) => {
            return RepoActionRunsPayload::failed(
                KIND_ERROR,
                &slug,
                format!("运行 gh 失败：{error}"),
            )
        }
    };

    if !output.is_ok() {
        let text = output.failure_text();
        return RepoActionRunsPayload::failed(
            classify_failure(&text).kind(),
            &slug,
            error_excerpt(&text),
        );
    }

    match parse_runs(&output.stdout, per_page) {
        Ok(runs) => RepoActionRunsPayload::found(&slug, runs),
        Err(error) => RepoActionRunsPayload::failed(
            KIND_ERROR,
            &slug,
            format!("gh 返回的运行列表无法解析：{error}"),
        ),
    }
}

/// 重跑一次运行。
#[tauri::command]
pub async fn github_run_rerun(repo: String, run_id: u64) -> Result<RepoRunActionResult, String> {
    blocking(move || Ok(run_action(&repo, run_id, RunAction::Rerun))).await
}

/// 取消一次正在进行的运行。
#[tauri::command]
pub async fn github_run_cancel(repo: String, run_id: u64) -> Result<RepoRunActionResult, String> {
    blocking(move || Ok(run_action(&repo, run_id, RunAction::Cancel))).await
}

/// 删掉一次运行的记录（日志与结果一起没，不可恢复）。
#[tauri::command]
pub async fn github_run_delete(repo: String, run_id: u64) -> Result<RepoRunActionResult, String> {
    blocking(move || Ok(run_action(&repo, run_id, RunAction::Delete))).await
}

/// 重跑 / 取消 / 删除只差一个 gh 子命令，预检、失败分类、原文透传完全一样，所以合成一处。
#[derive(Clone, Copy)]
enum RunAction {
    Rerun,
    Cancel,
    Delete,
}

impl RunAction {
    fn subcommand(self) -> &'static str {
        match self {
            RunAction::Rerun => "rerun",
            RunAction::Cancel => "cancel",
            RunAction::Delete => "delete",
        }
    }
}

fn run_action(repo: &str, run_id: u64, action: RunAction) -> RepoRunActionResult {
    let slug = match parse_repo_slug(repo) {
        Ok(slug) => slug,
        Err(message) => {
            return RepoRunActionResult::failed(KIND_ERROR, repo.trim(), run_id, message)
        }
    };
    // run id 是整数，拼不出选项注入；0 只可能是界面传错了，直接说清楚。
    if run_id == 0 {
        return RepoRunActionResult::failed(KIND_ERROR, &slug, run_id, "运行 id 不合法：0");
    }

    let id = run_id.to_string();
    let output = match gh::run(
        &["run", action.subcommand(), &id, "--repo", &slug],
        gh::RUN_ACTION_TIMEOUT_SECS,
    ) {
        Ok(output) => output,
        Err(GhRunError::NotInstalled) => return RepoRunActionResult::not_installed(&slug, run_id),
        Err(GhRunError::Io(error)) => {
            return RepoRunActionResult::failed(
                KIND_ERROR,
                &slug,
                run_id,
                format!("运行 gh 失败：{error}"),
            )
        }
    };

    if !output.is_ok() {
        let text = output.failure_text();
        return RepoRunActionResult::failed(
            classify_failure(&text).kind(),
            &slug,
            run_id,
            error_excerpt(&text),
        );
    }

    // 删除不可撤销：请求发出去还不算数，回查确认它真的没了才报成功。重跑/取消是「请求已发出
    // 即完成」的语义，不用回查。
    if matches!(action, RunAction::Delete) {
        return confirm_deleted(&slug, run_id);
    }
    RepoRunActionResult::ok(&slug, run_id)
}

/// 删除之后回查一次：只有查证它确实没了，才敢说「删掉了」。
///
/// 光看 `gh run delete` 的退出码不够——那条路上任何一环骗我们一次，界面就会把一条**其实还在
/// GitHub 上**的记录永久藏起来（行被拿掉、刷新又被滤掉），这比报个错糟糕得多。所以删完再来
/// 问一次「它还在吗」：明确 404 才算成功；还在就如实说「可能没删掉」；说不清就把原因带出去。
fn confirm_deleted(slug: &str, run_id: u64) -> RepoRunActionResult {
    let path = format!("repos/{slug}/actions/runs/{run_id}");
    // GitHub 删完是即刻生效的，但万一它慢半拍，先看一眼、再看一眼，别冤枉一次真删掉了的。
    for attempt in 0..2 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(800));
        }
        match gh::run(&["api", &path], gh::CI_TIMEOUT_SECS) {
            Ok(output) => {
                let text = output.failure_text();
                match classify_run_probe(output.is_ok(), &text) {
                    RunProbe::Gone => return RepoRunActionResult::ok(slug, run_id),
                    RunProbe::Present if attempt == 0 => continue,
                    RunProbe::Present => {
                        return RepoRunActionResult::failed(
                            KIND_ERROR,
                            slug,
                            run_id,
                            "gh 报告删除成功，但这条记录在 GitHub 上还在（可能没删掉）",
                        )
                    }
                    RunProbe::Unknown if attempt == 0 => continue,
                    RunProbe::Unknown => {
                        return RepoRunActionResult::failed(
                            KIND_ERROR,
                            slug,
                            run_id,
                            format!("删除请求已发出，但没能确认结果：{}", error_excerpt(&text)),
                        )
                    }
                }
            }
            // gh 刚才还能跑，回查却起不来：按「说不清」处理，别报成功。
            Err(GhRunError::NotInstalled) => {
                return RepoRunActionResult::failed(
                    KIND_ERROR,
                    slug,
                    run_id,
                    "删除请求已发出，但回查时找不到 gh 命令，没能确认结果",
                )
            }
            Err(GhRunError::Io(error)) => {
                return RepoRunActionResult::failed(
                    KIND_ERROR,
                    slug,
                    run_id,
                    format!("删除请求已发出，但回查失败：{error}"),
                )
            }
        }
    }
    // 循环里两条分支都会 return，这里只是兜底。
    RepoRunActionResult::failed(KIND_ERROR, slug, run_id, "删除请求已发出，但没能确认结果")
}

/// 一次运行的 job 与步骤树。
#[tauri::command]
pub async fn github_run_jobs(repo: String, run_id: u64) -> Result<RepoRunJobsPayload, String> {
    blocking(move || Ok(read_run_jobs(&repo, run_id))).await
}

fn read_run_jobs(repo: &str, run_id: u64) -> RepoRunJobsPayload {
    let slug = match parse_repo_slug(repo) {
        Ok(slug) => slug,
        Err(message) => {
            return RepoRunJobsPayload::failed(KIND_ERROR, repo.trim(), run_id, message)
        }
    };
    if run_id == 0 {
        return RepoRunJobsPayload::failed(KIND_ERROR, &slug, run_id, "运行 id 不合法：0");
    }

    let path = format!("repos/{slug}/actions/runs/{run_id}/jobs");
    let output = match gh::run(&["api", &path], gh::CI_TIMEOUT_SECS) {
        Ok(output) => output,
        Err(GhRunError::NotInstalled) => return RepoRunJobsPayload::not_installed(&slug, run_id),
        Err(GhRunError::Io(error)) => {
            return RepoRunJobsPayload::failed(
                KIND_ERROR,
                &slug,
                run_id,
                format!("运行 gh 失败：{error}"),
            )
        }
    };

    if !output.is_ok() {
        let text = output.failure_text();
        return RepoRunJobsPayload::failed(
            classify_failure(&text).kind(),
            &slug,
            run_id,
            error_excerpt(&text),
        );
    }

    match parse_jobs(&output.stdout) {
        // 一个 job 都没有：查清楚了，不是失败。
        Ok(jobs) if jobs.is_empty() => RepoRunJobsPayload::empty(&slug, run_id),
        Ok(jobs) => RepoRunJobsPayload::found(&slug, run_id, jobs),
        Err(error) => RepoRunJobsPayload::failed(
            KIND_ERROR,
            &slug,
            run_id,
            format!("gh 返回的 job 列表无法解析：{error}"),
        ),
    }
}

/// 一次运行的日志（所有 job 合并输出，与 `gh run view --log` 一致）。
///
/// `failed_only` 为真时只取失败步骤的日志（`gh run view --log-failed`），失败现场一屏看完。
#[tauri::command]
pub async fn github_run_log(
    repo: String,
    run_id: u64,
    failed_only: Option<bool>,
) -> Result<RepoRunLogPayload, String> {
    blocking(move || Ok(read_run_log(&repo, run_id, failed_only.unwrap_or(false)))).await
}

fn read_run_log(repo: &str, run_id: u64, failed_only: bool) -> RepoRunLogPayload {
    let slug = match parse_repo_slug(repo) {
        Ok(slug) => slug,
        Err(message) => return RepoRunLogPayload::failed(KIND_ERROR, repo.trim(), run_id, message),
    };
    if run_id == 0 {
        return RepoRunLogPayload::failed(KIND_ERROR, &slug, run_id, "运行 id 不合法：0");
    }

    let id = run_id.to_string();
    let flag = if failed_only { "--log-failed" } else { "--log" };
    let output = match gh::run_with_cap(
        &["run", "view", &id, flag, "--repo", &slug],
        gh::LOG_TIMEOUT_SECS,
        gh::LOG_STDOUT_CAP,
    ) {
        Ok(output) => output,
        Err(GhRunError::NotInstalled) => return RepoRunLogPayload::not_installed(&slug, run_id),
        Err(GhRunError::Io(error)) => {
            return RepoRunLogPayload::failed(
                KIND_ERROR,
                &slug,
                run_id,
                format!("运行 gh 失败：{error}"),
            )
        }
    };

    if !output.is_ok() {
        let text = output.failure_text();
        return RepoRunLogPayload::failed(
            classify_failure(&text).kind(),
            &slug,
            run_id,
            error_excerpt(&text),
        );
    }

    let lines = parse_log(&output.stdout);
    let (kept, clipped) = cap_lines(&lines, MAX_LOG_LINES);
    RepoRunLogPayload::found(
        &slug,
        run_id,
        kept,
        lines.len(),
        clipped,
        output.stdout_truncated,
    )
}

// ------------------------------------------------------------ issue / PR

/// 某个仓库的 issue / PR 列表。
///
/// `state` 是 `open` / `closed` / `all` —— 走 API 原生参数（切这个要重新发请求）。
/// 类型筛选（只看 issue 或只看 PR）与关键字在前端做：`issues` 端点一次就把两类
/// 都返回了，前端筛是零延迟。
#[tauri::command]
pub async fn github_issues(
    repo: String,
    state: Option<String>,
    limit: Option<usize>,
) -> Result<IssueListPayload, String> {
    let state = state.as_deref().unwrap_or("open").to_string();
    blocking(move || Ok(read_issues(&repo, &state, limit))).await
}

fn read_issues(repo: &str, state: &str, limit: Option<usize>) -> IssueListPayload {
    let slug = match parse_repo_slug(repo) {
        Ok(slug) => slug,
        Err(message) => return IssueListPayload::failed(KIND_ERROR, repo.trim(), message),
    };
    if let Some(problem) = issues::state_problem(state) {
        return IssueListPayload::failed(KIND_ERROR, &slug, problem);
    }

    let per_page = issues::clamp_limit(limit);
    let path = format!("repos/{slug}/issues?state={state}&per_page={per_page}");
    let output = match gh::run(&["api", &path], gh::ISSUES_TIMEOUT_SECS) {
        Ok(output) => output,
        Err(GhRunError::NotInstalled) => return IssueListPayload::not_installed(&slug),
        Err(GhRunError::Io(error)) => {
            return IssueListPayload::failed(KIND_ERROR, &slug, format!("运行 gh 失败：{error}"))
        }
    };

    if !output.is_ok() {
        let text = output.failure_text();
        return IssueListPayload::failed(
            classify_failure(&text).kind(),
            &slug,
            error_excerpt(&text),
        );
    }

    match issues::parse_issue_list(&output.stdout) {
        Ok(rows) => {
            // 拿满一页：后面多半还有，如实标记。
            let truncated = rows.len() >= per_page;
            IssueListPayload::found(&slug, rows, truncated)
        }
        Err(error) => IssueListPayload::failed(
            KIND_ERROR,
            &slug,
            format!("gh 返回的 issue 列表无法解析：{error}"),
        ),
    }
}

/// 一条 issue / PR 的详情：正文、评论、PR 专属信息、检查状态。
///
/// 正文 / 评论 / PR 信息互不依赖，**并行取**；检查状态要 PR 的 head sha，
/// 只能等 PR 信息到手后再查一次。所以 PR 详情是两轮往返，普通 issue 一轮。
#[tauri::command]
pub async fn github_issue_detail(
    repo: String,
    number: u64,
) -> Result<IssueDetailPayload, String> {
    blocking(move || Ok(read_issue_detail(&repo, number))).await
}

fn read_issue_detail(repo: &str, number: u64) -> IssueDetailPayload {
    let slug = match parse_repo_slug(repo) {
        Ok(slug) => slug,
        Err(message) => return IssueDetailPayload::failed(KIND_ERROR, repo.trim(), message),
    };
    if let Some(problem) = issues::number_problem(number) {
        return IssueDetailPayload::failed(KIND_ERROR, &slug, problem);
    }

    let issue_path = format!("repos/{slug}/issues/{number}");
    let comments_path = format!("repos/{slug}/issues/{number}/comments");
    // 先假定它是 PR 去问一次：普通 issue 会得到 404，忽略即可。这么问能省掉一轮往返。
    let pull_path = format!("repos/{slug}/pulls/{number}");

    let (issue_out, comments_out, pull_out) = std::thread::scope(|scope| {
        let issue = scope.spawn(|| gh::run(&["api", &issue_path], gh::ISSUE_DETAIL_TIMEOUT_SECS));
        let comments =
            scope.spawn(|| gh::run(&["api", &comments_path], gh::ISSUE_DETAIL_TIMEOUT_SECS));
        let pull = scope.spawn(|| gh::run(&["api", &pull_path], gh::ISSUE_DETAIL_TIMEOUT_SECS));
        (issue.join(), comments.join(), pull.join())
    });

    let issue_out = match issue_out {
        Ok(Ok(output)) => output,
        Ok(Err(GhRunError::NotInstalled)) => return IssueDetailPayload::not_installed(&slug),
        Ok(Err(GhRunError::Io(error))) => {
            return IssueDetailPayload::failed(KIND_ERROR, &slug, format!("运行 gh 失败：{error}"))
        }
        Err(_) => return IssueDetailPayload::failed(KIND_ERROR, &slug, "取详情时出错了"),
    };
    if !issue_out.is_ok() {
        let text = issue_out.failure_text();
        return IssueDetailPayload::failed(
            classify_failure(&text).kind(),
            &slug,
            error_excerpt(&text),
        );
    }

    let mut detail = match issues::parse_issue(&issue_out.stdout) {
        Ok(detail) => detail,
        Err(error) => {
            return IssueDetailPayload::failed(
                KIND_ERROR,
                &slug,
                format!("gh 返回的 issue 无法解析：{error}"),
            )
        }
    };

    // 评论取不到不该让整个详情打不开：正文照样给，评论区自己说一声。
    detail.comments = Vec::new();
    detail.comments_error = None;
    match comments_out {
        Ok(Ok(output)) if output.is_ok() => match issues::parse_comments(&output.stdout) {
            Ok(comments) => detail.comments = comments,
            Err(error) => detail.comments_error = Some(format!("评论无法解析：{error}")),
        },
        Ok(Ok(output)) => {
            let text = output.failure_text();
            detail.comments_error = Some(error_excerpt(&text));
        }
        Ok(Err(GhRunError::Io(error))) => {
            detail.comments_error = Some(format!("运行 gh 失败：{error}"));
        }
        _ => {
            detail.comments_error = Some("取评论时出错了".to_string());
        }
    }

    // PR 信息：只有它真是 PR 才算数。普通 issue 那次 404 是预期内的。
    detail.pull_request = None;
    detail.pull_request_error = None;
    if detail.is_pull_request {
        match pull_out {
            Ok(Ok(output)) if output.is_ok() => match issues::parse_pull_request(&output.stdout) {
                Ok(pr) => {
                    detail.is_draft = pr.draft;
                    detail.merged = pr.merged;
                    detail.pull_request = Some(pr);
                }
                Err(error) => {
                    detail.pull_request_error = Some(format!("PR 信息无法解析：{error}"));
                }
            },
            Ok(Ok(output)) => {
                let text = output.failure_text();
                detail.pull_request_error = Some(error_excerpt(&text));
            }
            Ok(Err(GhRunError::Io(error))) => {
                detail.pull_request_error = Some(format!("运行 gh 失败：{error}"));
            }
            _ => {
                detail.pull_request_error = Some("取 PR 信息时出错了".to_string());
            }
        }
    }

    // 检查状态要 head sha，只能第二轮。
    detail.checks = None;
    let head_sha = detail
        .pull_request
        .as_ref()
        .map(|pr| pr.head_sha.clone())
        .unwrap_or_default();
    if !head_sha.is_empty() {
        // 一页最多 100 条，得说清楚要 100：默认一页只有 30 条，40 个检查时只看到前 30，
        // 界面就会拿「没看完」当「全通过」。parse_checks 也据此标 truncated。
        let path = format!("repos/{slug}/commits/{head_sha}/check-runs?per_page=100");
        if let Ok(output) = gh::run(&["api", &path], gh::ISSUE_DETAIL_TIMEOUT_SECS) {
            if output.is_ok() {
                if let Ok(checks) = issues::parse_checks(&output.stdout) {
                    detail.checks = Some(checks);
                }
            }
        }
    }

    IssueDetailPayload::found(&slug, detail)
}

/// 给 issue / PR 加一条评论。
#[tauri::command]
pub async fn github_issue_comment(
    repo: String,
    number: u64,
    body: String,
) -> Result<IssueActionResult, String> {
    blocking(move || Ok(issue_comment(&repo, number, &body))).await
}

fn issue_comment(repo: &str, number: u64, body: &str) -> IssueActionResult {
    let slug = match parse_repo_slug(repo) {
        Ok(slug) => slug,
        Err(message) => {
            return IssueActionResult::failed(KIND_ERROR, repo.trim(), number, message)
        }
    };
    if let Some(problem) = issues::number_problem(number) {
        return IssueActionResult::failed(KIND_ERROR, &slug, number, problem);
    }
    if let Some(problem) = issues::body_problem(body) {
        return IssueActionResult::failed(KIND_ERROR, &slug, number, problem);
    }

    let path = format!("repos/{slug}/issues/{number}/comments");
    let payload = serde_json::json!({ "body": body.trim() });
    let args = ["api", "--method", "POST", &path, "--input", "-"];
    match gh::run_with_stdin(&args, &payload.to_string(), gh::ISSUE_ACTION_TIMEOUT_SECS) {
        Ok(output) if output.is_ok() => IssueActionResult::ok(&slug, number),
        Ok(output) => {
            let text = output.failure_text();
            IssueActionResult::failed(
                classify_failure(&text).kind(),
                &slug,
                number,
                error_excerpt(&text),
            )
        }
        Err(GhRunError::NotInstalled) => IssueActionResult::not_installed(&slug, number),
        Err(GhRunError::Io(error)) => {
            IssueActionResult::failed(KIND_ERROR, &slug, number, format!("运行 gh 失败：{error}"))
        }
    }
}

/// 打开或关闭一条 issue（PR 也一样，GitHub 那边是同一个东西）。
#[tauri::command]
pub async fn github_issue_set_state(
    repo: String,
    number: u64,
    state: String,
) -> Result<IssueActionResult, String> {
    blocking(move || Ok(issue_set_state(&repo, number, &state))).await
}

fn issue_set_state(repo: &str, number: u64, state: &str) -> IssueActionResult {
    let slug = match parse_repo_slug(repo) {
        Ok(slug) => slug,
        Err(message) => {
            return IssueActionResult::failed(KIND_ERROR, repo.trim(), number, message)
        }
    };
    if let Some(problem) = issues::number_problem(number) {
        return IssueActionResult::failed(KIND_ERROR, &slug, number, problem);
    }
    if state != "open" && state != "closed" {
        return IssueActionResult::failed(
            KIND_ERROR,
            &slug,
            number,
            format!("未知的操作目标：{state}"),
        );
    }

    let path = format!("repos/{slug}/issues/{number}");
    let payload = serde_json::json!({ "state": state });
    let args = ["api", "--method", "PATCH", &path, "--input", "-"];
    match gh::run_with_stdin(&args, &payload.to_string(), gh::ISSUE_ACTION_TIMEOUT_SECS) {
        Ok(output) if output.is_ok() => IssueActionResult::ok(&slug, number),
        Ok(output) => {
            let text = output.failure_text();
            IssueActionResult::failed(
                classify_failure(&text).kind(),
                &slug,
                number,
                error_excerpt(&text),
            )
        }
        Err(GhRunError::NotInstalled) => IssueActionResult::not_installed(&slug, number),
        Err(GhRunError::Io(error)) => {
            IssueActionResult::failed(KIND_ERROR, &slug, number, format!("运行 gh 失败：{error}"))
        }
    }
}

/// 合并一个 PR。`method` 是 `merge` / `squash` / `rebase`。
#[tauri::command]
pub async fn github_pr_merge(
    repo: String,
    number: u64,
    method: Option<String>,
) -> Result<IssueActionResult, String> {
    let method = method.as_deref().unwrap_or("squash").to_string();
    blocking(move || Ok(pr_merge(&repo, number, &method))).await
}

fn pr_merge(repo: &str, number: u64, method: &str) -> IssueActionResult {
    let slug = match parse_repo_slug(repo) {
        Ok(slug) => slug,
        Err(message) => {
            return IssueActionResult::failed(KIND_ERROR, repo.trim(), number, message)
        }
    };
    if let Some(problem) = issues::number_problem(number) {
        return IssueActionResult::failed(KIND_ERROR, &slug, number, problem);
    }
    if let Some(problem) = issues::merge_method_problem(method) {
        return IssueActionResult::failed(KIND_ERROR, &slug, number, problem);
    }

    let path = format!("repos/{slug}/pulls/{number}/merge");
    let payload = serde_json::json!({ "merge_method": method });
    let args = ["api", "--method", "PUT", &path, "--input", "-"];
    let output = match gh::run_with_stdin(&args, &payload.to_string(), gh::ISSUE_ACTION_TIMEOUT_SECS)
    {
        Ok(output) => output,
        Err(GhRunError::NotInstalled) => return IssueActionResult::not_installed(&slug, number),
        Err(GhRunError::Io(error)) => {
            return IssueActionResult::failed(
                KIND_ERROR,
                &slug,
                number,
                format!("运行 gh 失败：{error}"),
            )
        }
    };

    if !output.is_ok() {
        let text = output.failure_text();
        return IssueActionResult::failed(
            classify_failure(&text).kind(),
            &slug,
            number,
            error_excerpt(&text),
        );
    }
    // 合并**没成功**时 GitHub 可能也回 200，body 里是 merged:false。只看退出码
    // 会把没合说成合了，所以这里看 body。
    match issues::parse_merge_result(&output.stdout) {
        Ok(()) => IssueActionResult::ok(&slug, number),
        Err(reason) => IssueActionResult::failed(KIND_ERROR, &slug, number, reason),
    }
}

/// 新建一个 issue。`labels` 是逗号 / 空格分隔的标签名。
#[tauri::command]
pub async fn github_issue_create(
    repo: String,
    title: String,
    body: Option<String>,
    labels: Option<String>,
) -> Result<IssueActionResult, String> {
    let body = body.unwrap_or_default();
    let labels = labels.unwrap_or_default();
    blocking(move || Ok(issue_create(&repo, &title, &body, &labels))).await
}

fn issue_create(repo: &str, title: &str, body: &str, labels: &str) -> IssueActionResult {
    let slug = match parse_repo_slug(repo) {
        Ok(slug) => slug,
        Err(message) => return IssueActionResult::failed(KIND_ERROR, repo.trim(), 0, message),
    };
    if let Some(problem) = issues::title_problem(title) {
        return IssueActionResult::failed(KIND_ERROR, &slug, 0, problem);
    }

    let path = format!("repos/{slug}/issues");
    let mut payload = serde_json::json!({
        "title": title.trim(),
        "body": body.trim(),
    });
    let tag_names = issues::parse_labels(labels);
    if !tag_names.is_empty() {
        payload["labels"] = serde_json::json!(tag_names);
    }

    let args = ["api", "--method", "POST", &path, "--input", "-"];
    let output = match gh::run_with_stdin(&args, &payload.to_string(), gh::ISSUE_ACTION_TIMEOUT_SECS)
    {
        Ok(output) => output,
        Err(GhRunError::NotInstalled) => return IssueActionResult::not_installed(&slug, 0),
        Err(GhRunError::Io(error)) => {
            return IssueActionResult::failed(KIND_ERROR, &slug, 0, format!("运行 gh 失败：{error}"))
        }
    };

    if !output.is_ok() {
        let text = output.failure_text();
        return IssueActionResult::failed(
            classify_failure(&text).kind(),
            &slug,
            0,
            error_excerpt(&text),
        );
    }
    // 新建的编号要带回去，界面好跳到那条。
    let number = serde_json::from_str::<serde_json::Value>(&output.stdout)
        .ok()
        .and_then(|value| value.get("number").and_then(|n| n.as_u64()))
        .unwrap_or(0);
    IssueActionResult::ok(&slug, number)
}

/// 一次 Release 查询默认要几条；上限与运行列表同一档。
const RELEASES_DEFAULT_LIMIT: usize = 30;
const RELEASES_MAX_LIMIT: usize = 50;

/// 附件下载的总超时与「多久没有新数据算停滞」。卡死的代理不该让进度条永远停着。
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(1800);
const DOWNLOAD_STALL: Duration = Duration::from_secs(45);
const DOWNLOAD_CHUNK: usize = 256 * 1024;

/// 进度事件的通道名；前端按 `id` 把事件对回具体那一行。
pub const DOWNLOAD_EVENT: &str = "verta://github-download";

/// 某个仓库的 Release 列表（正文与附件都在同一份响应里）。
#[tauri::command]
pub async fn github_releases(
    repo: String,
    limit: Option<usize>,
) -> Result<RepoReleasesPayload, String> {
    blocking(move || Ok(read_releases(&repo, limit))).await
}

fn read_releases(repo: &str, limit: Option<usize>) -> RepoReleasesPayload {
    let slug = match parse_repo_slug(repo) {
        Ok(slug) => slug,
        Err(message) => return RepoReleasesPayload::failed(KIND_ERROR, repo.trim(), message),
    };

    let per_page = limit
        .unwrap_or(RELEASES_DEFAULT_LIMIT)
        .clamp(1, RELEASES_MAX_LIMIT);
    let path = format!("repos/{slug}/releases?per_page={per_page}");
    let output = match gh::run(&["api", &path], gh::CI_TIMEOUT_SECS) {
        Ok(output) => output,
        Err(GhRunError::NotInstalled) => return RepoReleasesPayload::not_installed(&slug),
        Err(GhRunError::Io(error)) => {
            return RepoReleasesPayload::failed(KIND_ERROR, &slug, format!("运行 gh 失败：{error}"))
        }
    };

    if !output.is_ok() {
        let text = output.failure_text();
        return RepoReleasesPayload::failed(
            classify_failure(&text).kind(),
            &slug,
            error_excerpt(&text),
        );
    }

    match releases::parse_releases(&output.stdout, per_page) {
        Ok(rows) => RepoReleasesPayload::ready(&slug, rows),
        Err(error) => RepoReleasesPayload::failed(
            KIND_ERROR,
            &slug,
            format!("gh 返回的 Release 列表无法解析：{error}"),
        ),
    }
}

/// 把一个 Release 附件下载到用户选的目录。
///
/// `id` 由前端生成，同一次下载的进度事件都带着它；`cancel` 命令按这个 id 找到标记。
/// 下载期间不占 async worker：整段读管道与写文件都在 blocking 池里。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn github_release_download(
    app: AppHandle,
    state: State<'_, DownloadState>,
    id: String,
    repo: String,
    asset_id: u64,
    name: String,
    dir: String,
    total: u64,
) -> Result<ReleaseDownloadResult, String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("下载标识是空的".to_string());
    }
    let slug = parse_repo_slug(&repo)?;
    let cancel = state.start(&id);
    let worker_app = app.clone();
    let worker_id = id.clone();
    let result = blocking(move || {
        Ok(download_asset(
            &worker_app,
            &worker_id,
            &slug,
            asset_id,
            &name,
            &dir,
            total,
            &cancel,
        ))
    })
    .await;
    state.finish(&id);
    result
}

/// 取消一次正在进行的下载。标记由下载循环每 250 ms 看一次。
#[tauri::command]
pub fn github_release_download_cancel(state: State<'_, DownloadState>, id: String) {
    state.cancel(id.trim());
}

/// 为什么下载没走完。取消不是错误，界面上不弹红字。
enum DownloadFailure {
    Cancelled,
    Failed(String),
}

#[allow(clippy::too_many_arguments)]
fn download_asset(
    app: &AppHandle,
    id: &str,
    slug: &str,
    asset_id: u64,
    name: &str,
    dir: &str,
    total: u64,
    cancel: &AtomicBool,
) -> ReleaseDownloadResult {
    if asset_id == 0 {
        return ReleaseDownloadResult::failed("附件 id 是 0");
    }
    let dir = Path::new(dir);
    if !dir.is_dir() {
        return ReleaseDownloadResult::failed(format!(
            "下载目录不存在或不是目录：{}",
            dir.display()
        ));
    }
    let name = match safe_file_name(name) {
        Ok(name) => name,
        Err(error) => return ReleaseDownloadResult::failed(error),
    };
    let dest = dir.join(&name);
    let tmp = dest.with_file_name(format!("{name}.verta-part"));

    let mut child = match spawn_download(slug, asset_id) {
        Ok(child) => child,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
            ) =>
        {
            return ReleaseDownloadResult::failed("未安装 gh CLI（找不到 gh 命令）")
        }
        Err(error) => {
            return ReleaseDownloadResult::failed(format!("无法启动 gh：{error}"));
        }
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return ReleaseDownloadResult::failed("取不到 gh 的输出管道");
    };
    let mut file = match std::fs::File::create(&tmp) {
        Ok(file) => file,
        Err(error) => {
            let _ = child.kill();
            return ReleaseDownloadResult::failed(format!("无法写入 {}：{error}", tmp.display()));
        }
    };

    // 读管道放独立线程：主线程用带超时的收包判断「卡住」，否则阻塞读会让超时检查根本执行不到。
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    std::thread::spawn(move || {
        let mut stdout = stdout;
        let mut buf = vec![0u8; DOWNLOAD_CHUNK];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) => {
                    let _ = tx.send(Ok(Vec::new()));
                    return;
                }
                Ok(count) => {
                    if tx.send(Ok(buf[..count].to_vec())).is_err() {
                        return;
                    }
                }
                Err(error) => {
                    let _ = tx.send(Err(error.to_string()));
                    return;
                }
            }
        }
    });

    let deadline = Instant::now() + DOWNLOAD_TIMEOUT;
    let mut last_data = Instant::now();
    let mut written = 0u64;
    let mut last_reported = 0u64;
    let mut last_reported_at = Instant::now();

    let outcome: Result<(), DownloadFailure> = loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            break Err(DownloadFailure::Cancelled);
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            break Err(DownloadFailure::Failed(format!(
                "下载超时（{} 分钟）",
                DOWNLOAD_TIMEOUT.as_secs() / 60
            )));
        }
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Ok(chunk)) if chunk.is_empty() => break Ok(()),
            Ok(Ok(chunk)) => {
                if let Err(error) = file.write_all(&chunk) {
                    let _ = child.kill();
                    break Err(DownloadFailure::Failed(format!("写入失败：{error}")));
                }
                written += chunk.len() as u64;
                last_data = Instant::now();
                let now = Instant::now();
                if should_report(last_reported, written, now - last_reported_at) {
                    emit_progress(app, id, written, total);
                    last_reported = written;
                    last_reported_at = now;
                }
            }
            Ok(Err(error)) => {
                let _ = child.kill();
                break Err(DownloadFailure::Failed(format!(
                    "读取下载数据失败：{error}"
                )));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if last_data.elapsed() > DOWNLOAD_STALL {
                    let _ = child.kill();
                    break Err(DownloadFailure::Failed(format!(
                        "下载停滞（{} 秒内没有收到数据）",
                        DOWNLOAD_STALL.as_secs()
                    )));
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break Ok(()),
        }
    };
    drop(file);

    if let Err(failure) = outcome {
        let _ = finish_download(&tmp, &dest, false);
        return match failure {
            DownloadFailure::Cancelled => ReleaseDownloadResult::cancelled(),
            DownloadFailure::Failed(reason) => ReleaseDownloadResult::failed(reason),
        };
    }

    let status = match child.wait() {
        Ok(status) => status,
        Err(error) => {
            let _ = finish_download(&tmp, &dest, false);
            return ReleaseDownloadResult::failed(format!("等待 gh 结束失败：{error}"));
        }
    };
    if !status.success() {
        let mut stderr = String::new();
        if let Some(mut pipe) = child.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr);
        }
        let _ = finish_download(&tmp, &dest, false);
        let text = stderr.trim();
        return ReleaseDownloadResult::failed(if text.is_empty() {
            format!("gh 退出码 {:?}", status.code())
        } else {
            text.to_string()
        });
    }

    // 附件大小是 GitHub 自己给的，收到的不一样就是没下完，不能转正。
    if total > 0 && written != total {
        let _ = finish_download(&tmp, &dest, false);
        return ReleaseDownloadResult::failed(format!(
            "下载不完整：收到 {written} 字节，附件大小是 {total} 字节"
        ));
    }

    if let Err(error) = finish_download(&tmp, &dest, true) {
        return ReleaseDownloadResult::failed(format!("写入 {} 失败：{error}", dest.display()));
    }
    emit_progress(app, id, written, total);
    ReleaseDownloadResult::ok(dest.to_string_lossy().to_string())
}

fn spawn_download(slug: &str, asset_id: u64) -> std::io::Result<std::process::Child> {
    let endpoint = format!("repos/{slug}/releases/assets/{asset_id}");
    let mut cmd = Command::new("gh");
    cmd.args(["api", &endpoint, "-H", "Accept: application/octet-stream"])
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    // gh 不读 Windows 的 Internet 设置，继承来的代理变量还可能为空串。
    let proxy = crate::modules::proxy::resolve(None);
    crate::modules::proxy::apply(&mut cmd, proxy.as_deref());
    cmd.spawn()
}

/// 进度事件发不出去（窗口关了）不该让下载失败。
fn emit_progress(app: &AppHandle, id: &str, written: u64, total: u64) {
    let _ = app.emit(
        DOWNLOAD_EVENT,
        ReleaseDownloadProgress {
            id: id.to_string(),
            written,
            total,
        },
    );
}
