use tauri::{AppHandle, Manager};

use crate::modules::git::operations;
use crate::modules::git::types::{
    DiscardEntry, GitBranchListResult, GitCommitFileChange, GitCommitResult, GitDiffContentResult,
    GitDiffResult, GitLogEntry, GitPanelSnapshot, GitPushResult, GitRepoInfo, GitStashEntry,
    GitStatusSnapshot,
};
use crate::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};

async fn blocking<F, T>(app: AppHandle, f: F) -> Result<T, String>
where
    F: FnOnce(&WorkspaceRegistry) -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<WorkspaceRegistry>();
        f(&registry)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_resolve_repo(
    cwd: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Option<GitRepoInfo>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::resolve_repo(r, &cwd, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_panel_snapshot(
    cwd: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitPanelSnapshot, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::panel_snapshot(r, &cwd, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_status(
    repo_root: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitStatusSnapshot, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::status(r, &repo_root, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_diff(
    repo_root: String,
    path: Option<String>,
    staged: bool,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitDiffResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::diff(r, &repo_root, path.as_deref(), staged, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_diff_content(
    repo_root: String,
    path: String,
    staged: bool,
    original_path: Option<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitDiffContentResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::diff_content(
            r,
            &repo_root,
            &path,
            staged,
            original_path.as_deref(),
            &workspace,
        )
        .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_stage(
    repo_root: String,
    paths: Vec<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::stage(r, &repo_root, &paths, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_unstage(
    repo_root: String,
    paths: Vec<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::unstage(r, &repo_root, &paths, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_discard(
    repo_root: String,
    entries: Vec<DiscardEntry>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::discard(r, &repo_root, &entries, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_commit(
    repo_root: String,
    message: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitCommitResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::commit(r, &repo_root, &message, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_fetch(
    repo_root: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::fetch(r, &repo_root, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_pull_ff_only(
    repo_root: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::pull_ff_only(r, &repo_root, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_push(
    repo_root: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitPushResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::push(r, &repo_root, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_log(
    repo_root: String,
    limit: Option<u32>,
    before_sha: Option<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Vec<GitLogEntry>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::log(
            r,
            &repo_root,
            limit.unwrap_or(30),
            before_sha.as_deref(),
            &workspace,
        )
        .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_show_commit(
    repo_root: String,
    sha: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitDiffResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::show_commit_diff(r, &repo_root, &sha, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_commit_files(
    repo_root: String,
    sha: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Vec<GitCommitFileChange>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::commit_files(r, &repo_root, &sha, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_commit_file_diff(
    repo_root: String,
    sha: String,
    path: String,
    original_path: Option<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitDiffContentResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::commit_file_diff(
            r,
            &repo_root,
            &sha,
            &path,
            original_path.as_deref(),
            &workspace,
        )
        .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_remote_url(
    repo_root: String,
    name: Option<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Option<String>, String> {
    let remote = name.unwrap_or_else(|| "origin".to_string());
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::remote_url(r, &repo_root, &remote, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_stash_list(
    repo_root: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Vec<GitStashEntry>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::stash_list(r, &repo_root, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_stash_push(
    repo_root: String,
    message: Option<String>,
    include_untracked: bool,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::stash_push(
            r,
            &repo_root,
            &workspace,
            message.as_deref(),
            include_untracked,
        )
        .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_stash_apply(
    repo_root: String,
    reference: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::stash_apply(r, &repo_root, &workspace, &reference).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_stash_pop(
    repo_root: String,
    reference: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::stash_pop(r, &repo_root, &workspace, &reference).map_err(Into::into)
    })
    .await
}

/// Drop a stash entry. The UI must confirm with the user before this step.
#[tauri::command]
pub async fn git_stash_drop(
    repo_root: String,
    reference: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::stash_drop(r, &repo_root, &workspace, &reference).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_list_branches(
    repo_root: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitBranchListResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::list_branches(r, &repo_root, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_checkout_branch(
    repo_root: String,
    branch: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::checkout_branch(r, &repo_root, &branch, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_create_branch(
    repo_root: String,
    name: String,
    start_point: Option<String>,
    switch: bool,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::create_branch(
            r,
            &repo_root,
            &workspace,
            &name,
            start_point.as_deref(),
            switch,
        )
        .map_err(Into::into)
    })
    .await
}

/// Delete a branch. `force` uses `-D`; the UI must confirm with the user before this
/// step.
#[tauri::command]
pub async fn git_delete_branch(
    repo_root: String,
    name: String,
    force: bool,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::delete_branch(r, &repo_root, &workspace, &name, force).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_rename_branch(
    repo_root: String,
    from: String,
    to: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::rename_branch(r, &repo_root, &workspace, &from, &to).map_err(Into::into)
    })
    .await
}

/// Create a worktree and return the new directory's path (the caller authorizes it once
/// more and can then open it).
#[tauri::command]
pub async fn git_worktree_add(
    repo_root: String,
    path: String,
    branch: String,
    create_new_branch: bool,
    start_point: Option<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<String, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::worktree_add(
            r,
            &repo_root,
            &workspace,
            &path,
            &branch,
            create_new_branch,
            start_point.as_deref(),
        )
        .map_err(Into::into)
    })
    .await
}

/// Remove a worktree. `force` discards uncommitted changes there, so the UI must
/// confirm first.
#[tauri::command]
pub async fn git_worktree_remove(
    repo_root: String,
    path: String,
    force: bool,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::worktree_remove(r, &repo_root, &workspace, &path, force).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_cherry_pick(
    repo_root: String,
    sha: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::cherry_pick(r, &repo_root, &workspace, &sha).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_revert_commit(
    repo_root: String,
    sha: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::revert_commit(r, &repo_root, &workspace, &sha).map_err(Into::into)
    })
    .await
}

/// Soft reset: move the branch pointer back to a commit, leaving the worktree intact.
#[tauri::command]
pub async fn git_reset_soft(
    repo_root: String,
    sha: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::reset_soft(r, &repo_root, &workspace, &sha).map_err(Into::into)
    })
    .await
}

/// Abort a stuck cherry-pick or revert; `kind` accepts only `cherry-pick` and `revert`.
#[tauri::command]
pub async fn git_abort_operation(
    repo_root: String,
    kind: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::abort_operation(r, &repo_root, &workspace, &kind).map_err(Into::into)
    })
    .await
}

/// Clone a repository into `dest` and return the target path (the caller authorizes it
/// once more and can then open it).
#[tauri::command]
pub async fn git_clone_repo(
    url: String,
    dest: String,
    workspace: Option<WorkspaceEnv>,
    depth: Option<u32>,
    app: AppHandle,
) -> Result<String, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::clone_repo(r, &url, &dest, &workspace, depth).map_err(Into::into)
    })
    .await
}
