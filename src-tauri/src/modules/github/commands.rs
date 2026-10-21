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
use super::ci::parse_latest_run;
use super::ci::parse_repo_slug;
use super::gh::{self, GhRunError, LoginProbe};
use super::permission;
pub use super::releases::DownloadState;
use super::releases::{self, finish_download, safe_file_name, should_report};
use super::repos::{
    classify_failure, error_excerpt, page_path, parse_login, parse_repos, should_continue_page,
    MAX_PAGES, MAX_PER_PAGE,
};
use super::types::{
    ReleaseDownloadProgress, ReleaseDownloadResult, RemoteRepo, RemoteReposPayload,
    RepoActionRunsPayload, RepoCiPayload, RepoPermissionPayload, RepoReleasesPayload,
    RepoRunActionResult, RepoRunJobsPayload, RepoRunLogPayload, KIND_ERROR,
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
