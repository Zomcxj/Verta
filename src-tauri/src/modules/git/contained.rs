//! Finding the repositories a folder contains, so the right-hand panel can offer them.
//!
//! The panel shows one repository at a time, and until now the one it showed was the folder itself
//! when that folder happened to be a repository. A session opened at a folder that holds several
//! projects - a workspace of checkouts, or a directory whose interesting work is one level down -
//! had nothing on the right, or showed the parent's changes while the work was in a child.
//!
//! This answers "which repositories are in here". A directory is a repository when it holds `.git`,
//! which is the plain checkout case; one inside a submodule or a linked worktree is not offered,
//! because the panel cannot drive one correctly and a wrong entry is worse than a missing one. The
//! scan goes down two levels: the folder itself, its children, and their children. Deeper costs more
//! than it finds - a checkout's `node_modules` is full of them.
//!
//! Each candidate is then asked when it last committed, because the panel has to pick one when
//! there are several, and "the one committed to most recently" is the one whose work is most likely
//! to be current. A repository with no commits sorts last: it has no such time.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

use crate::modules::git::process::git_stdout_line_opt;
use crate::modules::git::utils::canonical_dir;
use crate::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};

/// How far below the folder the scan looks: the folder itself, its children, their children.
const MAX_DEPTH: usize = 2;

/// Candidates one scan will name, so a folder one level above a checkout farm cannot make the
/// panel read thousands of them.
const MAX_CANDIDATES: usize = 64;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContainedRepo {
    /// The directory the repository is rooted at, in the spelling the caller sent.
    pub path: String,
    /// When its last commit was made, epoch milliseconds. `null` for a repository with no commits.
    pub committed_at_ms: Option<i64>,
}

#[cfg(test)]
#[path = "contained_tests.rs"]
mod tests;

/// The repositories at or below `folder`, most recently committed first.
#[tauri::command]
pub async fn git_contained_repos(
    folder: String,
    workspace: Option<WorkspaceEnv>,
    app: tauri::AppHandle,
) -> Result<Vec<ContainedRepo>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<WorkspaceRegistry>();
        find(&registry, &folder, &workspace).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn find(
    registry: &WorkspaceRegistry,
    folder: &str,
    workspace: &WorkspaceEnv,
) -> Result<Vec<ContainedRepo>, String> {
    let Ok(local) = canonical_dir(registry, folder, workspace) else {
        // Not a directory, or one this app was never given: nothing to look inside.
        return Ok(Vec::new());
    };
    if !registry.is_authorized(&local.local_path) {
        // A folder nobody opened is not one to go looking inside.
        return Ok(Vec::new());
    }
    let mut candidates = Vec::new();
    collect(&local.local_path, 0, &mut candidates);
    candidates.truncate(MAX_CANDIDATES);
    let mut found: Vec<ContainedRepo> = candidates
        .into_iter()
        .map(|path| ContainedRepo {
            committed_at_ms: last_commit_ms(workspace, &path),
            path: display_path(&path, folder, &local.local_path),
        })
        .collect();
    // Newest first, and a repository that has never been committed to goes last whichever way the
    // sort runs - `Option` orders `None` first, which is the opposite of what is wanted here.
    found.sort_by(|a, b| match (a.committed_at_ms, b.committed_at_ms) {
        (Some(x), Some(y)) => y.cmp(&x),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.path.cmp(&b.path),
    });
    Ok(found)
}

/// Directories holding `.git`, at most `MAX_DEPTH` levels below `start`.
fn collect(start: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if out.len() >= MAX_CANDIDATES {
        return;
    }
    if start.join(".git").exists() {
        out.push(start.to_path_buf());
        // A repository is not searched for repositories inside: its children belong to it, and
        // offering them would give the panel the same tree twice.
        return;
    }
    if depth >= MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(start) else {
        return;
    };
    let mut children: Vec<PathBuf> = entries
        .flatten()
        // Dot-directories are skipped: `.git`, `.vscode` and the various caches are never a project
        // a session is opened in.
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| entry.path())
        .collect();
    children.sort();
    for child in children {
        collect(&child, depth + 1, out);
    }
}

/// When the repository last committed, in epoch milliseconds.
///
/// `%ct` is the committer date in seconds. It is what "committed to most recently" means for a
/// branch that has been rewritten or rebased: the date of the commit at `HEAD`, not when the
/// checkout was made.
fn last_commit_ms(workspace: &WorkspaceEnv, repo: &Path) -> Option<i64> {
    let git_path = repo.to_string_lossy().replace('\\', "/");
    let seconds: i64 = git_stdout_line_opt(
        workspace,
        &git_path,
        ["log", "-1", "--format=%ct"],
    )
    .ok()??
    .parse()
    .ok()?;
    seconds.checked_mul(1000)
}

/// The path as the caller would spell it: the folder it sent, plus whatever the scan found below.
///
/// The scan walks real directories, which may be spelled with a canonical prefix the caller never
/// used; answering in the caller's spelling keeps the panel's identity checks stable.
fn display_path(found: &Path, folder: &str, local: &Path) -> String {
    let normalized = folder.replace('\\', "/");
    match found.strip_prefix(local) {
        Ok(rest) if rest.as_os_str().is_empty() => normalized.trim_end_matches('/').to_string(),
        Ok(rest) => {
            let tail = rest.to_string_lossy().replace('\\', "/");
            format!("{}/{}", normalized.trim_end_matches('/'), tail)
        }
        Err(_) => found.to_string_lossy().replace('\\', "/"),
    }
}
