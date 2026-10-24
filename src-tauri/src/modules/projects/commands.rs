//! The two commands behind the project list: scan a directory for repositories, and
//! fetch the status of many projects at once.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use crate::modules::git::operations;
use crate::modules::workspace::{resolve_path, WorkspaceEnv, WorkspaceRegistry};

use super::pull::pull_blocker;
use super::scan::discover_git_repos;
use super::types::{ProjectPullOutcome, ProjectStatus, ProjectTarget};

/// Status checks spawn git processes, run 4-way concurrently: 15 repositories do not
/// degenerate into ten-plus seconds, and the machine is not saturated.
const WORKERS: usize = 4;

/// Scan for repositories up to `max_depth` levels below `root`. The caller should have
/// authorized `root` first.
#[tauri::command]
pub async fn projects_scan(root: String, max_depth: Option<usize>) -> Result<Vec<String>, String> {
    crate::modules::fs::blocking(move || {
        let depth = max_depth.unwrap_or(2).min(8);
        let path = std::path::PathBuf::from(&root);
        if !path.is_dir() {
            return Err(format!("不是目录：{root}"));
        }
        Ok(discover_git_repos(&path, depth))
    })
    .await
}

/// Fetch statuses in bulk. Each row succeeds or fails on its own: one unreadable project
/// does not affect the others, and the reason lands in that row's `error` (per the spec:
/// never fail silently).
///
/// `fetch` true makes each row run `git fetch --prune` before reading its status, so
/// `ahead`/`behind` compare with the remote's current state rather than with the last time
/// anything fetched. A fetch only moves remote-tracking refs; it never touches a working
/// tree. When it fails that is carried in the row's `fetch_error`, and the status is still
/// read: an offline machine should still show what the local repository looks like.
#[tauri::command]
pub async fn projects_status(
    app: AppHandle,
    items: Vec<ProjectTarget>,
    fetch: Option<bool>,
) -> Result<Vec<ProjectStatus>, String> {
    crate::modules::fs::blocking(move || {
        let registry = app.state::<WorkspaceRegistry>();
        let registry: &WorkspaceRegistry = &registry;
        let fetch = fetch.unwrap_or(false);

        let slots: Mutex<Vec<(usize, ProjectStatus)>> = Mutex::new(Vec::with_capacity(items.len()));
        let next = AtomicUsize::new(0);
        let workers = WORKERS.min(items.len().max(1));

        std::thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(target) = items.get(index) else {
                        break;
                    };
                    let row = status_for(registry, target, fetch);
                    slots
                        .lock()
                        .expect("projects status slots poisoned")
                        .push((index, row));
                });
            }
        });

        let mut rows = slots.into_inner().expect("projects status slots poisoned");
        rows.sort_by_key(|(index, _)| *index);
        Ok(rows.into_iter().map(|(_, row)| row).collect())
    })
    .await
}

/// Pull one project: fetch plus a fast-forward-only merge of its upstream branch.
///
/// Refused when the upstream branch is named differently from the current branch, because
/// `git pull` would then merge that other branch into this one (see `pull.rs`). The refusal
/// is the command's error, so the reason reaches the user word for word; --ff-only means a
/// pull that cannot fast-forward fails instead of inventing a merge commit.
#[tauri::command]
pub async fn projects_pull(
    app: AppHandle,
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<ProjectPullOutcome, String> {
    crate::modules::fs::blocking(move || {
        let registry = app.state::<WorkspaceRegistry>();
        let registry: &WorkspaceRegistry = &registry;
        let workspace = WorkspaceEnv::from_option(workspace);
        pull_project(registry, &path, &workspace)
    })
    .await
}

fn pull_project(
    registry: &WorkspaceRegistry,
    path: &str,
    workspace: &WorkspaceEnv,
) -> Result<ProjectPullOutcome, String> {
    let Some(repo) = operations::resolve_repo(registry, path, workspace)? else {
        return Err(format!("不是 Git 仓库，不能拉取：{path}"));
    };
    let snapshot = operations::status(registry, &repo.repo_root, workspace)?;
    if let Some(reason) = pull_blocker(
        Some(snapshot.branch.as_str()),
        snapshot.upstream.as_deref(),
        snapshot.is_detached,
    ) {
        return Err(reason);
    }
    operations::pull_ff_only(registry, &repo.repo_root, workspace)?;
    Ok(ProjectPullOutcome {
        path: path.to_string(),
        branch: snapshot.branch,
    })
}

fn status_for(registry: &WorkspaceRegistry, target: &ProjectTarget, fetch: bool) -> ProjectStatus {
    let name = basename(&target.path);
    let workspace = target.workspace.clone();

    match operations::resolve_repo(registry, &target.path, &workspace) {
        Ok(Some(repo)) => {
            let mut row = ProjectStatus::bare(target, name, "repo");
            row.branch = Some(repo.branch.clone());
            row.upstream = repo.upstream.clone();
            row.detached = repo.is_detached;
            if fetch {
                // Before the read, so the comparison is with the remote as it is now.
                // A failure here is recorded and the read goes on regardless.
                row.fetch_error = operations::fetch(registry, &repo.repo_root, &workspace)
                    .err()
                    .map(|e| e.to_string());
            }
            match operations::status(registry, &repo.repo_root, &workspace) {
                Ok(snapshot) => {
                    row.branch = Some(snapshot.branch);
                    row.upstream = snapshot.upstream;
                    row.ahead = snapshot.ahead;
                    row.behind = snapshot.behind;
                    row.detached = snapshot.is_detached;
                    row.dirty = snapshot.changed_files.len() as u32;
                    // An unreadable stash count is not fatal: use 0, but do not let that
                    // pretend the project is clean.
                    row.stashed = operations::stash_count(registry, &repo.repo_root, &workspace)
                        .unwrap_or_default();
                }
                Err(e) => {
                    row.kind = "error";
                    row.error = Some(e.to_string());
                }
            }
            row
        }
        Ok(None) => ProjectStatus::bare(target, name, "notRepo"),
        Err(e) => {
            // "The path does not exist" must be told apart from other failures: the UI shows
            // "path missing" for the former and the cause for the latter.
            let resolved = resolve_path(&target.path, &workspace);
            if std::fs::metadata(&resolved).is_err() {
                ProjectStatus::bare(target, name, "missing")
            } else {
                let mut row = ProjectStatus::bare(target, name, "error");
                row.error = Some(e.to_string());
                row
            }
        }
    }
}

fn basename(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    match trimmed.rsplit(['/', '\\']).next() {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => trimmed.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::basename;

    #[test]
    fn basename_keeps_the_last_segment_whichever_separator() {
        assert_eq!(basename("F:\\work\\Verta"), "Verta");
        assert_eq!(basename("/home/cxj/workspace/token-monitor"), "token-monitor");
        assert_eq!(basename("F:\\work\\Verta\\"), "Verta");
        assert_eq!(basename("C:\\"), "C:");
    }
}