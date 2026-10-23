//! Commands behind the GitHub panel: use the locally logged-in gh CLI to fetch
//! repositories, CI status, run lists and details, and releases; plus rerun /
//! cancel / delete a run and download release assets into a user-chosen directory.
//!
//! gh is account-scoped, so it always runs in the host environment regardless of
//! the current space / distro. Pure logic lives in `repos.rs` / `ci.rs` /
//! `actions.rs` / `releases.rs`; this module only orchestrates.

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
    IssueListPayload, PullRequestCommit, ReleaseDownloadProgress, ReleaseDownloadResult, RemoteRepo,
    RemoteReposPayload, RepoActionRunsPayload, RepoActionResult, RepoCiPayload,
    RepoPermissionPayload, RepoReleasesPayload, RepoRunActionResult, RepoRunJobsPayload,
    RepoRunLogPayload, RepoSettingsPayload, KIND_ERROR,
};

/// Repositories the current account can reach (own + collaborator + visible to
/// org members).
///
/// `limit` caps the **page size**, clamped to 1..=100 and defaulting to 100; the
/// total is bounded by the page limit instead.
#[tauri::command]
pub async fn github_repos(limit: Option<usize>) -> Result<RemoteReposPayload, String> {
    // Spawning gh blocks, so it goes to the blocking pool rather than tying up an
    // async worker.
    blocking(move || Ok(list_repos(limit))).await
}

fn list_repos(limit: Option<usize>) -> RemoteReposPayload {
    let per_page = limit.unwrap_or(MAX_PER_PAGE).clamp(1, MAX_PER_PAGE);

    // One `gh api user` call confirms gh runs and is logged in, and hands us the
    // login name on the way.
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

    // The display name is a bonus: if it is unavailable, the list is unaffected.
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
            // A mid-paging failure is still reported honestly: the repos fetched so
            // far come back, but kind must not be ready.
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
        // A short page is the last one; a full page keeps paging until the limit.
        if !should_continue_page(count, per_page) {
            break;
        }
        if page == MAX_PAGES {
            // Stopped at the limit with a full last page: there are likely more, so
            // say so.
            truncated = true;
        }
    }

    RemoteReposPayload::ready(login, account_name, repos, truncated)
}

/// The latest CI run of a repository.
///
/// Triggered on demand by the UI, one repository at a time: querying every repo in
/// the list would burn through the API quota.
#[tauri::command]
pub async fn github_repo_ci(repo: String) -> Result<RepoCiPayload, String> {
    blocking(move || Ok(read_repo_ci(&repo))).await
}

fn read_repo_ci(repo: &str) -> RepoCiPayload {
    let slug = match parse_repo_slug(repo) {
        Ok(slug) => slug,
        // The name itself is invalid: say so without asking gh.
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
        // Definite answer: this repository has no runs.
        Ok(None) => RepoCiPayload::empty(&slug),
        Err(error) => RepoCiPayload::failed(
            KIND_ERROR,
            &slug,
            format!("gh 返回的运行记录无法解析：{error}"),
        ),
    }
}

/// The current account's permission on a repository; the UI decides from it
/// whether to offer write actions.
///
/// Like CI status, triggered on demand one repository at a time: querying every
/// repo in the list would burn through the API quota.
#[tauri::command]
pub async fn github_repo_permission(repo: String) -> Result<RepoPermissionPayload, String> {
    blocking(move || Ok(read_repo_permission(&repo))).await
}

fn read_repo_permission(repo: &str) -> RepoPermissionPayload {
    let slug = match parse_repo_slug(repo) {
        Ok(slug) => slug,
        // The name itself is invalid: say so without asking gh.
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

    // With no permission name (empty output) we render as "allowed" and do not get
    // in the user's way.
    let permission = permission::parse_permission(&output.stdout);
    let can_write = permission::write_allowed(permission.as_deref());
    RepoPermissionPayload::found(&slug, permission, can_write)
}

/// What the repo settings panel needs: description, visibility, and whether the
/// current account may change them.
///
/// Same source as the permission lookup (one `gh repo view`), but the two popups
/// query independently and share no cache.
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

/// Set the repository description; an empty string clears it.
#[tauri::command]
pub async fn github_repo_set_description(
    repo: String,
    description: String,
) -> Result<RepoActionResult, String> {
    blocking(move || Ok(repo_admin(&repo, RepoAdmin::Description(description)))).await
}

/// Toggle visibility. `private` true means private; before switching to public
/// the UI has already made the user accept the consequences.
#[tauri::command]
pub async fn github_repo_set_visibility(
    repo: String,
    private: bool,
) -> Result<RepoActionResult, String> {
    blocking(move || Ok(repo_admin(&repo, RepoAdmin::Visibility(private)))).await
}

/// Delete a repository. Irreversible: success is only reported after a follow-up
/// lookup confirms it is really gone.
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

    // GitHub always rejects an over-long description, so complain locally first
    // instead of making a pointless round trip.
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
            // gh demands explicit acceptance of the visibility-change consequences;
            // that is what the confirmation in the UI is for.
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
        // A missing delete_repo scope is a self-fixable failure: name the command to
        // run right in the message.
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

    // Deletion is irreversible: sending the request is not enough, success is only reported
    // once a follow-up lookup confirms it is gone.
    if matches!(action, RepoAdmin::Delete) {
        return confirm_repo_gone(&slug);
    }
    RepoActionResult::ok(&slug)
}

/// Confirm the repository is really gone: only an explicit 404 from
/// `gh api repos/{slug}` counts as deleted.
fn confirm_repo_gone(slug: &str) -> RepoActionResult {
    let path = format!("repos/{slug}");
    // Same approach as deleting a run: GitHub applies it immediately, but look once
    // more in case it lags.
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

/// The local gh CLI's login state.
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
        // Definite answer: no host is logged in. That is `none`, not an error.
        Ok(None) => AuthStatusPayload::none(),
        Err(error) => {
            let text = output.failure_text();
            // Older gh has no --json, or the output was polluted by something else:
            // fall back to detecting the login state from the text.
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

/// Log in with a pasted PAT. The token only lives in memory: it goes to gh's
/// stdin and is never persisted.
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

/// Browser auth: run `gh auth login --web` and stream what it prints (including
/// the one-time code) to the UI.
///
/// This step needs a human clicking in the browser, hence the ten-minute timeout;
/// it can be cancelled midway.
#[tauri::command]
pub async fn github_auth_login_web(
    app: AppHandle,
    state: State<'_, AuthLoginState>,
) -> Result<AuthActionPayload, String> {
    let worker_app = app.clone();
    // Copy the state out (Arc inside): the blocking closure must carry it over to
    // the background thread.
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
        // Keep interactive prompts: this path opens a browser on purpose and waits
        // for a human to finish there.
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
    // One reader thread per pipe: gh prints the one-time code on stderr, so it must
    // not be missed.
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
    // Give the reader threads time to drain the tail of the pipes.
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

/// Log out. The UI asks for confirmation before sending this.
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

/// During browser auth, append a chunk of gh output to the aggregate and push it
/// to the UI.
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

/// The last few lines gh printed, for failure messages; don't dump the whole
/// thing on the user.
fn last_lines(text: &str, count: usize) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let start = lines.len().saturating_sub(count);
    lines[start..].join(" / ")
}

/// Handle to the gh process doing browser auth (needed to cancel it).
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

    /// Cancel a browser auth: set the flag and kill the gh process.
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

/// A repository's recent runs.
///
/// Triggered on demand by the UI like the CI status: `limit` is how many rows to
/// fetch (clamped to 1..=50, default 20).
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

/// Rerun a run.
#[tauri::command]
pub async fn github_run_rerun(repo: String, run_id: u64) -> Result<RepoRunActionResult, String> {
    blocking(move || Ok(run_action(&repo, run_id, RunAction::Rerun))).await
}

/// Cancel a run in progress.
#[tauri::command]
pub async fn github_run_cancel(repo: String, run_id: u64) -> Result<RepoRunActionResult, String> {
    blocking(move || Ok(run_action(&repo, run_id, RunAction::Cancel))).await
}

/// Delete a run's record (logs and results go with it, unrecoverable).
#[tauri::command]
pub async fn github_run_delete(repo: String, run_id: u64) -> Result<RepoRunActionResult, String> {
    blocking(move || Ok(run_action(&repo, run_id, RunAction::Delete))).await
}

/// Rerun / cancel / delete differ only in the gh subcommand, while validation,
/// failure classification and raw-output passthrough are identical, so they share
/// one path.
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
    // The run id is an integer, so it cannot inject options; 0 can only be a bad
    // value from the UI, so say so outright.
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

    // Deletion is irreversible: sending the request is not enough, success is only
    // reported once a follow-up lookup confirms it is gone. Rerun/cancel mean
    // "accepted once sent", so no check-back is needed.
    if matches!(action, RunAction::Delete) {
        return confirm_deleted(&slug, run_id);
    }
    RepoRunActionResult::ok(&slug, run_id)
}

/// Check back once after deleting: only a confirmed disappearance justifies saying
/// "deleted".
///
/// The exit code of `gh run delete` alone is not enough: if any link in that chain
/// lies to us once, the UI would permanently hide a record that **is still on
/// GitHub** (row removed, and filtered out again on refresh), which is far worse
/// than reporting an error. So after deleting we ask "is it still there": an
/// explicit 404 means success; still present means we say it may not have been
/// deleted; anything unclear carries the reason back out.
fn confirm_deleted(slug: &str, run_id: u64) -> RepoRunActionResult {
    let path = format!("repos/{slug}/actions/runs/{run_id}");
    // GitHub applies the deletion immediately, but it may lag a beat: look once, then
    // again, so a genuine deletion is not reported as failed.
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
            // gh ran fine a moment ago but will not start now: treat it as unclear
            // rather than reporting success.
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
    // Both branches in the loop return; this is only a safety net.
    RepoRunActionResult::failed(KIND_ERROR, slug, run_id, "删除请求已发出，但没能确认结果")
}

/// A run's jobs and step tree.
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
        // No jobs at all: an answer we know, not a failure.
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

/// A run's log (all jobs merged, matching `gh run view --log`).
///
/// With `failed_only` set, only the failed steps' logs are fetched
/// (`gh run view --log-failed`), so the failure fits on one screen.
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

/// A repository's issue / PR list.
///
/// `state` is `open` / `closed` / `all` and goes through as a native API parameter
/// (switching it refetches). Type filtering (issues only / PRs only) and keyword
/// search happen in the frontend: the `issues` endpoint returns both kinds at
/// once, so filtering there is instant.
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
            // A full page came back: there are likely more, so say so.
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

/// Details of one issue / PR: body, comments, PR-specific info, commits, check status.
///
/// Body / comments / PR info are independent and fetched **in parallel**; the commit
/// list (PR only) waits for the PR info to confirm this is one, and the check status
/// needs the PR's head sha, so both come afterwards. A PR detail therefore takes
/// three round trips, a plain issue one.
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
    // Ask the PR endpoint speculatively: a plain issue yields a 404 that we ignore.
    // Asking up front saves a round trip.
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

    // Failing to fetch comments must not block the whole detail view: the body is
    // still shown and the comment section reports its own problem.
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

    // PR info: only counts if this really is a PR. The 404 for a plain issue is
    // expected.
    detail.pull_request = None;
    detail.pull_request_error = None;
    detail.commits = None;
    if detail.is_pull_request {
        match pull_out {
            Ok(Ok(output)) if output.is_ok() => match issues::parse_pull_request(&output.stdout) {
                Ok(pr) => {
                    detail.is_draft = pr.draft;
                    detail.merged = pr.merged;
                    detail.pull_request = Some(pr);
                    // PR-only, and asked for only after the PR endpoint answered:
                    // that answer is the proof this really is a PR. A failure here is
                    // not fatal, the block simply is not rendered.
                    detail.commits = read_pull_commits(&slug, number);
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

    // Check status needs the head sha, so it has to wait for the second round.
    detail.checks = None;
    let head_sha = detail
        .pull_request
        .as_ref()
        .map(|pr| pr.head_sha.clone())
        .unwrap_or_default();
    if !head_sha.is_empty() {
        // A page holds at most 100; ask for 100 explicitly, because the default is
        // 30 and with 40 checks we would only see the first 30, and the UI would
        // read "not all seen" as "all green". Beyond 100 we keep paging and count at
        // the end (summarize_check_pages remembers total_count and flags truncated
        // when items are missing).
        let mut pages: Vec<String> = Vec::new();
        for page in 1..=issues::CHECKS_MAX_PAGES {
            let page_path = issues::checks_page_path(&head_sha, page);
            let path = page_path.replace("{slug}", &slug);
            match gh::run(&["api", &path], gh::ISSUE_DETAIL_TIMEOUT_SECS) {
                Ok(output) if output.is_ok() => {
                    let rows = issues::count_check_runs(&output.stdout);
                    pages.push(output.stdout);
                    if !rows.is_some_and(|count| issues::checks_have_more(count, page)) {
                        break;
                    }
                }
                // Later pages unavailable: still return what we have; truncated /
                // total tells the user about the shortfall.
                _ => break,
            }
        }
        if !pages.is_empty() {
            if let Ok(checks) = issues::summarize_check_pages(&pages) {
                detail.checks = Some(checks);
            }
        }
    }

    IssueDetailPayload::found(&slug, detail)
}

/// Commit list of a PR.
///
/// `None` on any failure (gh missing, 404, unparsable): the commit block is an extra
/// next to the PR basics, so it reports nothing rather than sinking the detail view,
/// exactly like the comment block does.
fn read_pull_commits(slug: &str, number: u64) -> Option<Vec<PullRequestCommit>> {
    // A single page: see `issues::pull_commits_path`.
    let path = issues::pull_commits_path(number).replace("{slug}", slug);
    match gh::run(&["api", &path], gh::ISSUE_DETAIL_TIMEOUT_SECS) {
        Ok(output) if output.is_ok() => issues::parse_pull_commits(&output.stdout).ok(),
        _ => None,
    }
}

/// Add a comment to an issue / PR.
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

/// Open or close an issue (PRs too: on GitHub they are the same object).
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

/// Merge a PR. `method` is `merge` / `squash` / `rebase`.
///
/// `head_sha` is the PR's head when the confirmation dialog opened, and it rides
/// along with the merge: between the click and the request landing, someone may
/// have pushed to that branch, and without the sha we would merge commits the user
/// never saw. GitHub answers 409 on a sha mismatch, and we pass that through
/// verbatim instead of merging quietly.
#[tauri::command]
pub async fn github_pr_merge(
    repo: String,
    number: u64,
    method: Option<String>,
    head_sha: Option<String>,
) -> Result<IssueActionResult, String> {
    let method = method.as_deref().unwrap_or("squash").to_string();
    let head_sha = head_sha.unwrap_or_default();
    blocking(move || Ok(pr_merge(&repo, number, &method, &head_sha))).await
}

fn pr_merge(repo: &str, number: u64, method: &str, head_sha: &str) -> IssueActionResult {
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
    let head_sha = head_sha.trim();
    if let Some(problem) = issues::head_sha_problem(head_sha) {
        return IssueActionResult::failed(KIND_ERROR, &slug, number, problem);
    }

    let path = format!("repos/{slug}/pulls/{number}/merge");
    let mut body = serde_json::json!({ "merge_method": method });
    if !head_sha.is_empty() {
        // An empty sha omits the field: merging still works with old gh or after a
        // failed detail fetch, just without that safeguard.
        body["sha"] = serde_json::Value::String(head_sha.to_string());
    }
    let payload = body.to_string();
    let args = ["api", "--method", "PUT", &path, "--input", "-"];
    let output = match gh::run_with_stdin(&args, &payload, gh::ISSUE_ACTION_TIMEOUT_SECS) {
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
    // A merge that **did not** happen can still return 200 with merged:false in the
    // body. The exit code alone would report a failed merge as done, so read the
    // body instead.
    match issues::parse_merge_result(&output.stdout) {
        Ok(()) => IssueActionResult::ok(&slug, number),
        Err(reason) => IssueActionResult::failed(KIND_ERROR, &slug, number, reason),
    }
}

/// Review a PR. `event` is `approve` / `request_changes`, mapped to GitHub's
/// `APPROVE` / `REQUEST_CHANGES`; `body` is an optional comment on the review.
#[tauri::command]
pub async fn github_pr_review(
    repo: String,
    number: u64,
    event: String,
    body: Option<String>,
) -> Result<IssueActionResult, String> {
    let body = body.unwrap_or_default();
    blocking(move || Ok(pr_review(&repo, number, &event, &body))).await
}

fn pr_review(repo: &str, number: u64, event: &str, body: &str) -> IssueActionResult {
    let slug = match parse_repo_slug(repo) {
        Ok(slug) => slug,
        Err(message) => {
            return IssueActionResult::failed(KIND_ERROR, repo.trim(), number, message)
        }
    };
    if let Some(problem) = issues::number_problem(number) {
        return IssueActionResult::failed(KIND_ERROR, &slug, number, problem);
    }
    let event = match issues::review_event(event) {
        Ok(event) => event,
        Err(problem) => return IssueActionResult::failed(KIND_ERROR, &slug, number, problem),
    };

    let path = format!("repos/{slug}/pulls/{number}/reviews");
    let payload = issues::review_payload(event, body).to_string();
    let args = ["api", "--method", "POST", &path, "--input", "-"];
    let output = match gh::run_with_stdin(&args, &payload, gh::ISSUE_ACTION_TIMEOUT_SECS) {
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
    IssueActionResult::ok(&slug, number)
}

/// Create an issue. `labels` is a comma / space separated list of label names.
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
    // Return the new number so the UI can jump to it.
    let number = serde_json::from_str::<serde_json::Value>(&output.stdout)
        .ok()
        .and_then(|value| value.get("number").and_then(|n| n.as_u64()))
        .unwrap_or(0);
    IssueActionResult::ok(&slug, number)
}

/// Default number of releases per query; the cap matches the run list's.
const RELEASES_DEFAULT_LIMIT: usize = 30;
const RELEASES_MAX_LIMIT: usize = 50;

/// Overall timeout for an asset download and how long without new data counts as
/// stalled. A wedged proxy must not leave the progress bar hanging forever.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(1800);
const DOWNLOAD_STALL: Duration = Duration::from_secs(45);
const DOWNLOAD_CHUNK: usize = 256 * 1024;

/// Event channel name for progress; the frontend matches events to their row by
/// `id`.
pub const DOWNLOAD_EVENT: &str = "verta://github-download";

/// A repository's release list (bodies and assets all come in one response).
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

/// Download a release asset into a user-chosen directory.
///
/// `id` is generated by the frontend and carried by every progress event of this
/// download; the `cancel` command finds the flag by that id. The download holds no
/// async worker: both pipe reading and file writing run on the blocking pool.
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

/// Cancel an in-flight download. The download loop checks the flag every 250 ms.
#[tauri::command]
pub fn github_release_download_cancel(state: State<'_, DownloadState>, id: String) {
    state.cancel(id.trim());
}

/// Why a download did not complete. Cancellation is not an error, so the UI shows
/// no red banner.
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

    // Read the pipe on its own thread: the main thread uses timed receives to detect
    // a stall, since a blocking read would mean the timeout check never runs.
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

    // The asset size comes from GitHub; a mismatch means the download is incomplete,
    // so the partial file must not be promoted.
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
    // gh ignores Windows' Internet settings, and an inherited proxy variable may be
    // an empty string.
    let proxy = crate::modules::proxy::resolve(None);
    crate::modules::proxy::apply(&mut cmd, proxy.as_deref());
    cmd.spawn()
}

/// A progress event that cannot be sent (the window is closed) must not fail the
/// download.
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
