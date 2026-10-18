//! 项目列表用的两条命令：扫描目录找仓库、批量取每个项目的状态。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use crate::modules::git::operations;
use crate::modules::workspace::{resolve_path, WorkspaceRegistry};

use super::scan::discover_git_repos;
use super::types::{ProjectStatus, ProjectTarget};

/// 取状态要起 git 进程，按 4 路并发跑：15 个仓库不至于串成十几秒，也不会把机器压满。
const WORKERS: usize = 4;

/// 扫描 `root` 之下 `max_depth` 层以内的仓库。调用方应先把 `root` 授权过。
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

/// 批量取状态。每条都独立成败：一个项目读不出来不影响其余项目，失败原因放在那一行的
/// `error` 里（spec 约定：不许静默失败）。
#[tauri::command]
pub async fn projects_status(
    app: AppHandle,
    items: Vec<ProjectTarget>,
) -> Result<Vec<ProjectStatus>, String> {
    crate::modules::fs::blocking(move || {
        let registry = app.state::<WorkspaceRegistry>();
        let registry: &WorkspaceRegistry = &registry;

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
                    let row = status_for(registry, target);
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

fn status_for(registry: &WorkspaceRegistry, target: &ProjectTarget) -> ProjectStatus {
    let name = basename(&target.path);
    let workspace = target.workspace.clone();

    match operations::resolve_repo(registry, &target.path, &workspace) {
        Ok(Some(repo)) => {
            let mut row = ProjectStatus::bare(target, name, "repo");
            row.branch = Some(repo.branch.clone());
            row.upstream = repo.upstream.clone();
            row.detached = repo.is_detached;
            match operations::status(registry, &repo.repo_root, &workspace) {
                Ok(snapshot) => {
                    row.branch = Some(snapshot.branch);
                    row.upstream = snapshot.upstream;
                    row.ahead = snapshot.ahead;
                    row.behind = snapshot.behind;
                    row.detached = snapshot.is_detached;
                    row.dirty = snapshot.changed_files.len() as u32;
                    // 储藏数读不出来不算致命：给 0，但不能因此说这个项目「干净」而瞒着。
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
            // 路径压根不在 与 其它失败要分开：前者在界面上是「路径不存在」，后者要露出原因。
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