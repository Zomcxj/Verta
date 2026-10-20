//! GitHub 面板的命令：借本机已登录的 gh CLI 取仓库、CI 状态与运行列表，并能重跑/取消一次运行。
//!
//! 现在有四片：仓库列表（`github_repos`）、单个仓库的 CI 状态（`github_repo_ci`）、
//! 运行列表（`github_repo_runs`）与运行上的重跑/取消（`github_run_rerun` /
//! `github_run_cancel`）。Releases 与资产下载留给后续切片。gh 是账号级的东西，一律在主机
//! 环境跑，与当前空间 / 发行版无关。纯逻辑放在 `repos.rs` / `ci.rs` / `actions.rs`，这里只做编排。

use crate::modules::fs::blocking;

use super::actions::{
    cap_lines, clamp_limit, classify_run_probe, parse_jobs, parse_log, parse_runs, RunProbe,
    MAX_LOG_LINES,
};
use super::ci::parse_latest_run;
use super::ci::parse_repo_slug;
use super::gh::{self, GhRunError, LoginProbe};
use super::repos::{
    classify_failure, error_excerpt, page_path, parse_login, parse_repos, should_continue_page,
    MAX_PAGES, MAX_PER_PAGE,
};
use super::types::{
    RemoteRepo, RemoteReposPayload, RepoActionRunsPayload, RepoCiPayload, RepoRunActionResult,
    RepoRunJobsPayload, RepoRunLogPayload, KIND_ERROR,
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
