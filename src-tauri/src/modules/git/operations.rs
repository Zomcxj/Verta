use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::Path;

use crate::modules::git::errors::{GitError, Result};
use crate::modules::git::parser::{parse_porcelain_v2, parse_stash_list};
use crate::modules::git::process::{
    ensure_git_available, ensure_success, git_show_text, git_stdout_line_opt, git_stdout_lines,
    read_text_file, run_git, run_git_capped,
};
use crate::modules::git::types::{
    DiscardEntry, GitBranchEntry, GitBranchListResult, GitChangedFile, GitCommitFileChange,
    GitCommitResult, GitDiffContentResult, GitDiffResult, GitLogEntry, GitOutput, GitPanelSnapshot,
    GitPushResult, GitRepoInfo, GitStashEntry, GitStatusSnapshot, TextSource, CLONE_TIMEOUT_SECS,
    DEFAULT_TIMEOUT_SECS, NETWORK_TIMEOUT_SECS,
};
use crate::modules::git::untracked;
use crate::modules::git::utils::{
    authorized_repo_root, canonical_dir, display_path, resolve_within_repo, split_upstream,
    ResolvedGitDirectory,
};
use crate::modules::workspace::{resolve_path, WorkspaceEnv, WorkspaceRegistry};

pub fn resolve_repo(
    registry: &WorkspaceRegistry,
    cwd: &str,
    workspace: &WorkspaceEnv,
) -> Result<Option<GitRepoInfo>> {
    let cwd = canonical_dir(registry, cwd, workspace)?;
    if !registry.is_authorized(&cwd.local_path) {
        return Err(GitError::PathOutsideWorkspace(cwd.local_path));
    }
    ensure_git_available(&cwd.workspace)?;
    resolve_repo_in_authorized(registry, &cwd)
}

fn resolve_repo_in_authorized(
    registry: &WorkspaceRegistry,
    cwd: &ResolvedGitDirectory,
) -> Result<Option<GitRepoInfo>> {
    let Some(root_line) = git_stdout_line_opt(
        &cwd.workspace,
        &cwd.git_path,
        ["rev-parse", "--show-toplevel"],
    )?
    else {
        return Ok(None);
    };
    let canonical_root = canonical_dir(registry, &root_line, &cwd.workspace)?;
    let _ = registry.authorize(&canonical_root.local_path);

    let head = match git_stdout_lines(
        &canonical_root.workspace,
        &canonical_root.git_path,
        ["rev-parse", "--abbrev-ref", "HEAD"],
    )?
    .into_iter()
    .next()
    {
        Some(h) => h,
        None => git_stdout_line_opt(
            &canonical_root.workspace,
            &canonical_root.git_path,
            ["symbolic-ref", "--short", "HEAD"],
        )?
        .ok_or(GitError::CommandFailed {
            context: "failed to resolve HEAD",
            detail: String::new(),
        })?,
    };

    let upstream = git_stdout_line_opt(
        &canonical_root.workspace,
        &canonical_root.git_path,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )?;

    Ok(Some(GitRepoInfo {
        repo_root: canonical_root.git_path,
        branch: head.clone(),
        upstream,
        is_detached: head == "HEAD",
    }))
}

pub fn panel_snapshot(
    registry: &WorkspaceRegistry,
    cwd: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitPanelSnapshot> {
    let cwd = canonical_dir(registry, cwd, workspace)?;
    if !registry.is_authorized(&cwd.local_path) {
        return Err(GitError::PathOutsideWorkspace(cwd.local_path));
    }
    ensure_git_available(&cwd.workspace)?;
    let Some(root_line) = git_stdout_line_opt(
        &cwd.workspace,
        &cwd.git_path,
        ["rev-parse", "--show-toplevel"],
    )?
    else {
        return Ok(GitPanelSnapshot {
            repo: None,
            status: None,
        });
    };
    let canonical_root = canonical_dir(registry, &root_line, &cwd.workspace)?;
    let _ = registry.authorize(&canonical_root.local_path);

    let status = status_inner(&canonical_root)?;
    let repo = GitRepoInfo {
        repo_root: canonical_root.git_path.clone(),
        branch: status.branch.clone(),
        upstream: status.upstream.clone(),
        is_detached: status.is_detached,
    };
    Ok(GitPanelSnapshot {
        repo: Some(repo),
        status: Some(status),
    })
}

pub fn status(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitStatusSnapshot> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    status_inner(&repo_root)
}

fn status_inner(repo_root: &ResolvedGitDirectory) -> Result<GitStatusSnapshot> {
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        [
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=normal",
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git status failed")?;

    let stdout = std::str::from_utf8(&output.stdout).unwrap_or("");
    let parsed = parse_porcelain_v2(stdout);
    let files = untracked::expand_untracked_dirs(parsed.files, |dir, budget| {
        list_untracked_in(repo_root, dir, budget)
    });
    let files = with_line_counts(files, working_tree_line_counts(repo_root));

    Ok(GitStatusSnapshot {
        repo_root: repo_root.git_path.clone(),
        branch: parsed.branch,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
        is_detached: parsed.is_detached,
        truncated: output.truncated,
        changed_files: files,
    })
}

/// Number of stash entries. Each line of `git stash list` is one entry, so just
/// count the lines.
pub fn stash_count(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<u32> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    let lines = git_stdout_lines(&repo_root.workspace, &repo_root.git_path, ["stash", "list"])?;
    Ok(lines.len() as u32)
}

/// The stash list. Reference and description are NUL separated so spaces in the
/// description cannot confuse parsing.
pub fn stash_list(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<Vec<GitStashEntry>> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let lines = git_stdout_lines(
        &repo_root.workspace,
        &repo_root.git_path,
        ["stash", "list", "--format=%gd%x00%gs"],
    )?;
    // Join the lines back into one string so the parsing logic exists only once.
    Ok(parse_stash_list(&lines.join("\n")))
}

/// Stash the current changes. `include_untracked` decides whether untracked files go
/// along; an empty `message` uses git's own default description.
pub fn stash_push(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
    message: Option<&str>,
    include_untracked: bool,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;

    let mut args: Vec<OsString> = vec!["stash".into(), "push".into()];
    if include_untracked {
        args.push("--include-untracked".into());
    }
    let message = message.map(str::trim).filter(|m| !m.is_empty());
    if let Some(message) = message {
        args.push("-m".into());
        args.push(message.into());
    }

    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    // With no changes git exits 0 and says "No local changes"; that is not a failure.
    ensure_success(&output, "git stash push failed")
}

/// Apply a stash entry back to the worktree and keep it. `reference` looks like
/// `stash@{0}`.
pub fn stash_apply(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
    reference: &str,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["stash", "apply", reference],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git stash apply failed")
}

/// Apply a stash entry back to the worktree and drop it. On conflict git keeps the
/// entry; the error is passed through as-is.
pub fn stash_pop(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
    reference: &str,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["stash", "pop", reference],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git stash pop failed")
}

/// Drop a stash entry. The caller must confirm with the user first: this is
/// irreversible.
pub fn stash_drop(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
    reference: &str,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["stash", "drop", reference],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git stash drop failed")
}

/// Files git reports as untracked (and not ignored) under `dir`, or `None` when
/// there are more than `budget` or the listing fails. The walk is abandoned as
/// soon as the output exceeds what `budget` entries could need.
fn list_untracked_in(
    repo_root: &ResolvedGitDirectory,
    dir: &str,
    budget: usize,
) -> Option<Vec<String>> {
    let output = run_git_capped(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        [
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--full-name",
            "--",
            dir,
        ],
        DEFAULT_TIMEOUT_SECS,
        untracked::LISTING_CAP_BYTES,
    )
    .ok()?;
    if output.truncated || output.timed_out {
        return None;
    }
    // A listing that was cut short by the cap above reports exit failure.
    if output.exit_code != Some(0) {
        return None;
    }
    untracked::parse_listing(&output.stdout, budget)
}

pub fn diff(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    path: Option<&str>,
    staged: bool,
    workspace: &WorkspaceEnv,
) -> Result<GitDiffResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    diff_inner(&repo_root, path, staged)
}

fn diff_inner(
    repo_root: &ResolvedGitDirectory,
    path: Option<&str>,
    staged: bool,
) -> Result<GitDiffResult> {
    let mut args: Vec<OsString> = vec!["diff".into(), "--no-ext-diff".into()];
    if staged {
        args.push("--cached".into());
    }
    let pathspec = match path.filter(|p| !p.is_empty()) {
        Some(p) => Some(pathspec_from_input(&repo_root.local_path, p)?),
        None => None,
    };
    if let Some(spec) = pathspec.as_ref() {
        args.push("--".into());
        args.push(spec.clone().into());
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git diff failed")?;

    let diff_text = match String::from_utf8(output.stdout) {
        Ok(text) => text,
        Err(e) => String::from_utf8_lossy(&e.into_bytes()).into_owned(),
    };
    Ok(GitDiffResult {
        diff_text,
        truncated: output.truncated,
    })
}

pub fn diff_content(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    path: &str,
    staged: bool,
    original_path: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<GitDiffContentResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let worktree_path = resolve_within_repo(&repo_root.local_path, path)?;
    let rel_path = pathspec(&repo_root.local_path, &worktree_path);

    let original_rel = match original_path {
        Some(orig) if !orig.is_empty() => {
            let resolved = resolve_within_repo(&repo_root.local_path, orig)?;
            Some(pathspec(&repo_root.local_path, &resolved))
        }
        _ => None,
    };

    let original = if staged {
        let spec = original_rel.as_deref().unwrap_or(&rel_path);
        git_show_text(
            &repo_root.workspace,
            &repo_root.git_path,
            &format!("HEAD:{spec}"),
        )?
    } else {
        git_show_text(
            &repo_root.workspace,
            &repo_root.git_path,
            &format!(":{rel_path}"),
        )?
    };
    let modified = if staged {
        git_show_text(
            &repo_root.workspace,
            &repo_root.git_path,
            &format!(":{rel_path}"),
        )?
    } else {
        read_text_file(&worktree_path)?
    };
    let patch = diff_inner(&repo_root, Some(&rel_path), staged)?;
    let is_binary =
        matches!(original, TextSource::Binary) || matches!(modified, TextSource::Binary);

    Ok(GitDiffContentResult {
        original_content: original.into_text(),
        modified_content: modified.into_text(),
        is_binary,
        fallback_patch: patch.diff_text,
        truncated: patch.truncated,
    })
}

pub fn stage(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    paths: &[String],
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if paths.is_empty() {
        return Ok(());
    }
    let resolved = resolve_pathspecs(&repo_root.local_path, paths)?;
    let mut args: Vec<OsString> = vec!["add".into(), "--".into()];
    for p in &resolved {
        args.push(p.clone().into());
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git add failed")
}

pub fn unstage(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    paths: &[String],
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if paths.is_empty() {
        return Ok(());
    }
    let resolved = resolve_pathspecs(&repo_root.local_path, paths)?;
    let mut reset_args: Vec<OsString> = vec!["reset".into(), "HEAD".into(), "--".into()];
    for p in &resolved {
        reset_args.push(p.clone().into());
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        reset_args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    if output.exit_code == Some(0) {
        return Ok(());
    }
    if !looks_like_no_head(&output) {
        return ensure_success(&output, "git reset failed");
    }
    let mut rm_args: Vec<OsString> = vec!["rm".into(), "--cached".into(), "-r".into(), "--".into()];
    for p in &resolved {
        rm_args.push(p.clone().into());
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        rm_args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git rm --cached failed")
}

fn looks_like_no_head(output: &GitOutput) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    stderr.contains("ambiguous argument 'head'")
        || stderr.contains("unknown revision")
        || stderr.contains("does not have any commits yet")
        || stderr.contains("bad revision 'head'")
}

pub fn discard(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    entries: &[DiscardEntry],
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if entries.is_empty() {
        return Ok(());
    }

    let mut tracked: Vec<String> = Vec::with_capacity(entries.len());
    let mut untracked: Vec<String> = Vec::new();
    for entry in entries {
        let resolved = pathspec_from_input(&repo_root.local_path, &entry.path)?;
        if entry.untracked {
            untracked.push(resolved);
        } else {
            tracked.push(resolved);
        }
    }

    if !tracked.is_empty() {
        let mut args: Vec<OsString> = vec!["restore".into(), "--worktree".into(), "--".into()];
        for p in &tracked {
            args.push(p.clone().into());
        }
        let output = run_git(
            &repo_root.workspace,
            Some(&repo_root.git_path),
            args,
            DEFAULT_TIMEOUT_SECS,
        )?;
        ensure_success(&output, "git restore failed")?;
    }

    if !untracked.is_empty() {
        let mut args: Vec<OsString> = vec!["clean".into(), "-f".into(), "-d".into(), "--".into()];
        for p in &untracked {
            args.push(p.clone().into());
        }
        let output = run_git(
            &repo_root.workspace,
            Some(&repo_root.git_path),
            args,
            DEFAULT_TIMEOUT_SECS,
        )?;
        ensure_success(&output, "git clean failed")?;
    }

    Ok(())
}

pub fn commit(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    message: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitCommitResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err(GitError::EmptyCommitMessage);
    }

    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        [OsStr::new("commit"), OsStr::new("-m"), OsStr::new(trimmed)],
        DEFAULT_TIMEOUT_SECS,
    )?;
    if output.exit_code != Some(0) && nothing_to_commit(&output) {
        return Err(GitError::command("git commit", "nothing staged"));
    }
    ensure_success(&output, "git commit failed")?;

    let combined = git_stdout_lines(
        &repo_root.workspace,
        &repo_root.git_path,
        ["show", "-s", "--format=%H%n%s", "HEAD"],
    )?;
    let sha = combined.first().cloned().ok_or(GitError::CommandFailed {
        context: "failed to resolve commit sha",
        detail: String::new(),
    })?;
    let summary = combined.get(1).cloned().unwrap_or_default();

    Ok(GitCommitResult {
        commit_sha: sha,
        summary,
    })
}

pub fn push(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitPushResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;

    let upstream = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )?;
    if upstream.is_none() {
        return Err(GitError::NoUpstream);
    }

    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["push"],
        NETWORK_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git push failed")?;

    let upstream = upstream.unwrap();
    let (remote, branch) = split_upstream(&upstream);
    Ok(GitPushResult {
        remote,
        branch,
        pushed: true,
    })
}

const LOG_FORMAT: &str = "%H%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%s";
const MAX_LOG_LIMIT: u32 = 200;

pub fn log(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    limit: u32,
    before_sha: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<Vec<GitLogEntry>> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let bounded = limit.clamp(1, MAX_LOG_LIMIT);
    let count_arg = format!("--max-count={bounded}");
    let format_arg = format!("--format={LOG_FORMAT}");
    let cursor = match before_sha {
        Some(sha) if !sha.is_empty() => {
            if !sha_is_safe(sha) {
                return Err(GitError::command("git log", "invalid cursor sha"));
            }
            Some(format!("{sha}^"))
        }
        _ => None,
    };
    let mut args: Vec<&OsStr> = vec![
        OsStr::new("log"),
        OsStr::new("--no-color"),
        OsStr::new("--shortstat"),
        OsStr::new(&count_arg),
        OsStr::new(&format_arg),
    ];
    if let Some(spec) = cursor.as_deref() {
        args.push(OsStr::new(spec));
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    if output.timed_out {
        return Err(GitError::TimedOut("git log"));
    }
    if output.exit_code != Some(0) {
        let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        if stderr.contains("does not have any commits yet")
            || stderr.contains("bad default revision")
            || stderr.contains("unknown revision")
            || stderr.contains("ambiguous argument 'head'")
        {
            return Ok(Vec::new());
        }
        return ensure_success(&output, "git log failed").map(|_| Vec::new());
    }
    let stdout = std::str::from_utf8(&output.stdout).unwrap_or("");
    let mut entries: Vec<GitLogEntry> = Vec::with_capacity(bounded as usize);
    // Lines we get back interleave:
    //   <sha>\x1f<author>\x1f<email>\x1f<ts>\x1f<parents>\x1f<subject>
    //   <blank>
    //    5 files changed, 12 insertions(+), 3 deletions(-)
    // Commits without diffstats (root commits, merges with no changes) just
    // skip the shortstat line. Detect commit headers by the presence of
    // the unit-separator we put in the format.
    for raw_line in stdout.lines() {
        let line = raw_line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        if line.contains('\x1f') {
            let mut fields = line.splitn(6, '\x1f');
            let sha = fields.next().unwrap_or("").to_string();
            if !sha_is_safe(&sha) {
                continue;
            }
            let author = fields.next().unwrap_or("").to_string();
            let author_email = fields.next().unwrap_or("").to_string();
            let timestamp = fields.next().unwrap_or("0").parse::<i64>().unwrap_or(0);
            let parents_raw = fields.next().unwrap_or("");
            let parents: Vec<String> = parents_raw
                .split_ascii_whitespace()
                .map(|s| s.to_string())
                .collect();
            let subject = fields.next().unwrap_or("").to_string();
            let short_sha = sha.chars().take(7).collect::<String>();
            entries.push(GitLogEntry {
                sha,
                short_sha,
                author,
                author_email,
                timestamp_secs: timestamp,
                parents,
                subject,
                files_changed: 0,
                insertions: 0,
                deletions: 0,
            });
            continue;
        }
        if let Some(current) = entries.last_mut() {
            if line.contains("file changed") || line.contains("files changed") {
                let (files, ins, del) = parse_shortstat(line);
                current.files_changed = files;
                current.insertions = ins;
                current.deletions = del;
            }
        }
    }
    Ok(entries)
}

pub fn show_commit_diff(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    sha: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitDiffResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::command("git show", "invalid commit identifier"));
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        [
            OsStr::new("show"),
            OsStr::new("--no-color"),
            OsStr::new("--no-ext-diff"),
            OsStr::new("--patch-with-stat"),
            OsStr::new(sha),
            OsStr::new("--"),
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git show failed")?;
    let diff_text = match String::from_utf8(output.stdout) {
        Ok(text) => text,
        Err(e) => String::from_utf8_lossy(&e.into_bytes()).into_owned(),
    };
    Ok(GitDiffResult {
        diff_text,
        truncated: output.truncated,
    })
}

fn parse_shortstat(tail: &str) -> (u32, u32, u32) {
    // Looks for a line like " 5 files changed, 12 insertions(+), 3 deletions(-)"
    for line in tail.lines() {
        let trimmed = line.trim();
        if !(trimmed.contains("file changed") || trimmed.contains("files changed")) {
            continue;
        }
        let mut files = 0u32;
        let mut ins = 0u32;
        let mut del = 0u32;
        for part in trimmed.split(',') {
            let part = part.trim();
            let num_str = part.split_ascii_whitespace().next().unwrap_or("0");
            let n: u32 = num_str.parse().unwrap_or(0);
            if part.contains("file") {
                files = n;
            } else if part.contains("insertion") {
                ins = n;
            } else if part.contains("deletion") {
                del = n;
            }
        }
        return (files, ins, del);
    }
    (0, 0, 0)
}

fn sha_is_safe(sha: &str) -> bool {
    !sha.is_empty() && sha.len() <= 64 && sha.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn commit_files(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    sha: &str,
    workspace: &WorkspaceEnv,
) -> Result<Vec<GitCommitFileChange>> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::command("git diff-tree", "invalid commit sha"));
    }

    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        [
            OsStr::new("diff-tree"),
            OsStr::new("--no-commit-id"),
            OsStr::new("-r"),
            OsStr::new("-z"),
            OsStr::new("--name-status"),
            OsStr::new("--numstat"),
            OsStr::new(sha),
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git diff-tree failed")?;

    let (name_status_bytes, numstat_bytes) = split_name_status_numstat(&output.stdout);
    let mut files = parse_diff_tree_name_status(name_status_bytes);
    apply_numstat(&mut files, numstat_bytes);
    Ok(files)
}

fn split_name_status_numstat(bytes: &[u8]) -> (&[u8], &[u8]) {
    let s = std::str::from_utf8(bytes).unwrap_or("");
    let tokens: Vec<(usize, &str)> = s
        .split('\0')
        .scan(0usize, |off, t| {
            let start = *off;
            *off += t.len() + 1;
            Some((start, t))
        })
        .collect();
    let mut split_at = bytes.len();
    for (idx, tok) in tokens.iter().enumerate() {
        if tok.1.contains('\t') {
            split_at = tok.0;
            // Walk back: numstat for R/C with -z emits "<a>\t<r>" then two
            // NUL-separated paths. The two trailing path tokens belong to the
            // numstat block, not name-status.
            let _ = idx;
            break;
        }
    }
    (&bytes[..split_at], &bytes[split_at..])
}

pub fn commit_file_diff(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    sha: &str,
    path: &str,
    original_path: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<GitDiffContentResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::command("git show", "invalid commit sha"));
    }
    let resolved = resolve_within_repo(&repo_root.local_path, path)?;
    let rel = resolved
        .strip_prefix(&repo_root.local_path)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.replace('\\', "/"));

    let original_rel = match original_path {
        Some(orig) if !orig.is_empty() => {
            let resolved_orig = resolve_within_repo(&repo_root.local_path, orig)?;
            resolved_orig
                .strip_prefix(&repo_root.local_path)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| orig.replace('\\', "/"))
        }
        _ => rel.clone(),
    };

    let parent = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["rev-parse", &format!("{sha}^")],
    )?;
    let original = match parent.as_deref() {
        Some(p) => git_show_text(
            &repo_root.workspace,
            &repo_root.git_path,
            &format!("{p}:{original_rel}"),
        )?,
        None => TextSource::Missing,
    };
    let modified = git_show_text(
        &repo_root.workspace,
        &repo_root.git_path,
        &format!("{sha}:{rel}"),
    )?;

    let mut diff_args: Vec<OsString> = vec![
        "show".into(),
        "--no-color".into(),
        "--no-ext-diff".into(),
        "--format=".into(),
        "-m".into(),
        "--first-parent".into(),
        sha.into(),
        "--".into(),
    ];
    diff_args.push(rel.clone().into());
    if original_rel != rel {
        diff_args.push(original_rel.clone().into());
    }
    let patch_output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        diff_args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&patch_output, "git show <commit> -- <path> failed")?;
    let patch_text = match String::from_utf8(patch_output.stdout) {
        Ok(text) => text,
        Err(e) => String::from_utf8_lossy(&e.into_bytes()).into_owned(),
    };

    let is_binary =
        matches!(original, TextSource::Binary) || matches!(modified, TextSource::Binary);

    Ok(GitDiffContentResult {
        original_content: original.into_text(),
        modified_content: modified.into_text(),
        is_binary,
        fallback_patch: patch_text,
        truncated: patch_output.truncated,
    })
}

pub fn remote_url(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    name: &str,
    workspace: &WorkspaceEnv,
) -> Result<Option<String>> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if name.is_empty() || name.len() > 64 || !name.chars().all(is_remote_name_char) {
        return Ok(None);
    }
    git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["config", "--get", &format!("remote.{name}.url")],
    )
}

fn is_remote_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'
}

fn parse_diff_tree_name_status(bytes: &[u8]) -> Vec<GitCommitFileChange> {
    let s = std::str::from_utf8(bytes).unwrap_or("");
    let mut tokens = s.split('\0').filter(|t| !t.is_empty());
    let mut files: Vec<GitCommitFileChange> = Vec::new();
    while let Some(status_tok) = tokens.next() {
        let status_char = status_tok.chars().next().unwrap_or(' ');
        if status_char == 'R' || status_char == 'C' {
            let original = match tokens.next() {
                Some(v) => v.to_string(),
                None => break,
            };
            let new_path = match tokens.next() {
                Some(v) => v.to_string(),
                None => break,
            };
            files.push(GitCommitFileChange {
                path: new_path,
                original_path: Some(original),
                status: status_char.to_string(),
                status_label: status_label_for(status_char),
                added: 0,
                removed: 0,
                is_binary: false,
            });
        } else {
            let path = match tokens.next() {
                Some(v) => v.to_string(),
                None => break,
            };
            files.push(GitCommitFileChange {
                path,
                original_path: None,
                status: status_char.to_string(),
                status_label: status_label_for(status_char),
                added: 0,
                removed: 0,
                is_binary: false,
            });
        }
    }
    files
}

fn apply_numstat(files: &mut [GitCommitFileChange], bytes: &[u8]) {
    let s = std::str::from_utf8(bytes).unwrap_or("");
    let tokens: Vec<&str> = s.split('\0').filter(|t| !t.is_empty()).collect();
    let mut idx = 0;
    while idx < tokens.len() {
        let header = tokens[idx];
        idx += 1;
        let mut cols = header.splitn(3, '\t');
        let added_raw = cols.next().unwrap_or("0");
        let removed_raw = cols.next().unwrap_or("0");
        let inline_path = cols.next().unwrap_or("");
        let is_binary = added_raw == "-" && removed_raw == "-";
        let added: u32 = if is_binary {
            0
        } else {
            added_raw.parse().unwrap_or(0)
        };
        let removed: u32 = if is_binary {
            0
        } else {
            removed_raw.parse().unwrap_or(0)
        };

        let (path, original) = if inline_path.is_empty() {
            let original = tokens.get(idx).map(|s| s.to_string()).unwrap_or_default();
            idx += 1;
            let new_path = tokens.get(idx).map(|s| s.to_string()).unwrap_or_default();
            idx += 1;
            (new_path, Some(original))
        } else {
            (inline_path.to_string(), None)
        };

        if path.is_empty() {
            continue;
        }
        if let Some(file) = files.iter_mut().find(|f| f.path == path) {
            file.added = added;
            file.removed = removed;
            file.is_binary = is_binary;
            if file.original_path.is_none() {
                if let Some(orig) = original {
                    if !orig.is_empty() && orig != file.path {
                        file.original_path = Some(orig);
                    }
                }
            }
        }
    }
}

/// Added and removed line counts per path, keyed by the path the **status** reports (the new one
/// for a rename).
///
/// The two sides are summed because they answer the same question as the row: how much this file
/// differs from HEAD. A file that is staged and then edited again appears in both reads, and
/// showing only one of them would understate it. Binary files report `-` for both counts and are
/// left out of the map, so a row with a binary change shows no numbers rather than a wrong `+0`.
fn merge_numstat(into: &mut HashMap<String, (u32, u32)>, bytes: &[u8]) {
    let s = std::str::from_utf8(bytes).unwrap_or("");
    let tokens: Vec<&str> = s.split('\0').filter(|t| !t.is_empty()).collect();
    let mut idx = 0;
    while idx < tokens.len() {
        let header = tokens[idx];
        idx += 1;
        let mut cols = header.splitn(3, '\t');
        let added_raw = cols.next().unwrap_or("0");
        let removed_raw = cols.next().unwrap_or("0");
        let inline_path = cols.next().unwrap_or("");
        if added_raw == "-" || removed_raw == "-" {
            continue;
        }
        let added: u32 = added_raw.parse().unwrap_or(0);
        let removed: u32 = removed_raw.parse().unwrap_or(0);
        let path = if inline_path.is_empty() {
            // `-z` puts a rename's two paths in their own tokens: the original, then the new one.
            idx += 1;
            let new_path = tokens.get(idx).copied().unwrap_or("");
            idx += 1;
            new_path
        } else {
            inline_path
        };
        if path.is_empty() {
            continue;
        }
        let entry = into.entry(path.to_string()).or_insert((0, 0));
        entry.0 += added;
        entry.1 += removed;
    }
}

/// Reads the working tree's line counts against HEAD. `None` means the read itself failed; the
/// status is still returned, without numbers.
///
/// Two reads, because `git diff` alone only compares the working tree with the index: a fully
/// staged file would come back empty. Merging both into one map makes a file that is staged and
/// then edited again read as its total difference from HEAD.
fn working_tree_line_counts(
    repo_root: &ResolvedGitDirectory,
) -> Option<HashMap<String, (u32, u32)>> {
    let worktree = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["diff", "--no-ext-diff", "--numstat", "-z", "--"],
        DEFAULT_TIMEOUT_SECS,
    )
    .ok()?;
    let staged = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        [
            "diff",
            "--no-ext-diff",
            "--cached",
            "--numstat",
            "-z",
            "--",
        ],
        DEFAULT_TIMEOUT_SECS,
    )
    .ok()?;
    let mut counts = HashMap::new();
    merge_numstat(&mut counts, &worktree.stdout);
    merge_numstat(&mut counts, &staged.stdout);
    Some(counts)
}

/// Attaches the counts to the rows `git status` reported. Paths the read did not mention keep
/// `None`, so their rows simply show no numbers.
fn with_line_counts(
    files: Vec<GitChangedFile>,
    counts: Option<HashMap<String, (u32, u32)>>,
) -> Vec<GitChangedFile> {
    let Some(counts) = counts else {
        return files;
    };
    files
        .into_iter()
        .map(|mut file| {
            if let Some((added, removed)) = counts.get(&file.path) {
                file.added = Some(*added);
                file.removed = Some(*removed);
            }
            file
        })
        .collect()
}

fn status_label_for(c: char) -> String {
    match c {
        'A' => "Added".into(),
        'M' => "Modified".into(),
        'D' => "Deleted".into(),
        'R' => "Renamed".into(),
        'C' => "Copied".into(),
        'T' => "Type changed".into(),
        'U' => "Unmerged".into(),
        _ => format!("Status {c}"),
    }
}

pub fn fetch(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["fetch", "--prune"],
        NETWORK_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git fetch failed")
}

pub fn pull_ff_only(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["pull", "--ff-only"],
        NETWORK_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git pull --ff-only failed")
}

fn nothing_to_commit(output: &GitOutput) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    let stdout = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    stderr.contains("nothing to commit") || stdout.contains("nothing to commit")
}

fn resolve_pathspecs(repo_root: &Path, paths: &[String]) -> Result<Vec<String>> {
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        out.push(pathspec_from_input(repo_root, p)?);
    }
    Ok(out)
}

fn pathspec_from_input(repo_root: &Path, rel: &str) -> Result<String> {
    let resolved = resolve_within_repo(repo_root, rel)?;
    Ok(pathspec(repo_root, &resolved))
}

fn pathspec(repo_root: &Path, absolute: &Path) -> String {
    absolute
        .strip_prefix(repo_root)
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| absolute.to_string_lossy().replace('\\', "/"))
}

pub fn list_branches(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitBranchListResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;

    let mut branches: Vec<GitBranchEntry> = Vec::new();

    let current_branch = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["rev-parse", "--abbrev-ref", "HEAD"],
    )
    .ok()
    .flatten();
    let is_detached_head = current_branch.as_deref() == Some("HEAD");

    if let Ok(lines) = git_stdout_lines(
        &repo_root.workspace,
        &repo_root.git_path,
        ["branch", "--format=%(refname:short)%00%(HEAD)"],
    ) {
        for line in &lines {
            let mut parts = line.split('\0');
            let name = parts.next().unwrap_or("").to_string();
            let head_marker = parts.next().unwrap_or("");
            let is_head = head_marker == "*";
            if !name.is_empty() {
                branches.push(GitBranchEntry {
                    name,
                    kind: "local".into(),
                    worktree_path: None,
                    is_head,
                    is_detached: is_head && is_detached_head,
                });
            }
        }
    }

    if let Ok(lines) = git_stdout_lines(
        &repo_root.workspace,
        &repo_root.git_path,
        ["worktree", "list", "--porcelain"],
    ) {
        let mut current_worktree: Option<String> = None;
        let mut worktree_branch: Option<String> = None;
        let mut worktree_bare = false;
        let mut head_sha: Option<String> = None;
        for line in &lines {
            if let Some(rest) = line.strip_prefix("worktree ") {
                if let Some(wt_path) = current_worktree.take() {
                    if !worktree_bare {
                        push_worktree(
                            &mut branches,
                            wt_path,
                            worktree_branch.take(),
                            head_sha.take(),
                        );
                    }
                }
                current_worktree = Some(rest.trim().to_string());
                worktree_branch = None;
                worktree_bare = false;
                head_sha = None;
            } else if let Some(rest) = line.strip_prefix("HEAD ") {
                head_sha = Some(rest.trim().to_string());
            } else if let Some(rest) = line.strip_prefix("branch ") {
                let raw = rest.trim();
                worktree_branch = Some(raw.strip_prefix("refs/heads/").unwrap_or(raw).to_string());
            } else if line.starts_with("bare") {
                worktree_bare = true;
            }
        }
        if let Some(wt_path) = current_worktree.take() {
            if !worktree_bare {
                push_worktree(
                    &mut branches,
                    wt_path,
                    worktree_branch.take(),
                    head_sha.take(),
                );
            }
        }
    }

    // Prefer a branch's worktree entry over its local one, except for the current
    // branch: the main worktree is always listed, so !is_head keeps it local.
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut deduped: Vec<GitBranchEntry> = Vec::with_capacity(branches.len());
    for b in branches {
        if let Some(&existing_idx) = seen.get(&b.name) {
            let existing = &deduped[existing_idx];
            let should_replace = b.kind == "worktree"
                && existing.kind == "local"
                && existing.worktree_path.is_none()
                && !existing.is_head;
            if should_replace {
                let is_head = existing.is_head || b.is_head;
                deduped[existing_idx] = GitBranchEntry { is_head, ..b };
            } else if b.is_head && !existing.is_head {
                let mut updated = deduped[existing_idx].clone();
                updated.is_head = true;
                deduped[existing_idx] = updated;
            }
        } else {
            seen.insert(b.name.clone(), deduped.len());
            deduped.push(b);
        }
    }

    deduped.sort_by(|a, b| {
        let kind_ord = |k: &str| if k == "local" { 0u8 } else { 1u8 };
        kind_ord(&a.kind)
            .cmp(&kind_ord(&b.kind))
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(GitBranchListResult { branches: deduped })
}

fn push_worktree(
    branches: &mut Vec<GitBranchEntry>,
    path: String,
    branch: Option<String>,
    head_sha: Option<String>,
) {
    let name = if let Some(ref b) = branch {
        b.clone()
    } else if let Some(ref sha) = head_sha {
        // if detached HEAD with no branch; show shortened SHA as name
        let short = if sha.len() >= 7 {
            &sha[..7]
        } else {
            sha.as_str()
        };
        format!("(detached @ {})", short)
    } else {
        return;
    };
    branches.push(GitBranchEntry {
        name,
        kind: "worktree".into(),
        worktree_path: Some(path),
        is_head: false,
        is_detached: branch.is_none(),
    });
}

pub fn checkout_branch(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    branch_name: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let branch_name = check_ref(branch_name)?;
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["checkout", &branch_name],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git checkout failed")
}

/// Pre-check for branch names and revisions.
///
/// git rejects invalid names on its own; this only catches the two things git does not
/// reject early enough: empty values, and values starting with `-`; the latter get
/// parsed as options, which is argument injection in practice. Everything else is left
/// to git, whose error is passed through to the user verbatim.
fn check_ref(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.starts_with('-') {
        return Err(GitError::InvalidRefName(value.to_string()));
    }
    Ok(value.to_string())
}

/// Clone URL pre-check: reject empty values, values starting with `-`, and anything
/// containing whitespace or control characters.
fn check_clone_url(url: &str) -> Result<String> {
    let url = url.trim();
    let unusable = url.is_empty()
        || url.starts_with('-')
        || url.chars().any(|c| c.is_whitespace() || c.is_control());
    if unusable {
        return Err(GitError::command(
            "git clone",
            format!("refusing to clone from {url:?}"),
        ));
    }
    Ok(url.to_string())
}

/// Split `F:/code/thing` into (`F:/code`, `thing`); likewise `/home/me/thing`.
///
/// Purely a string split, no disk access: the target directory does not exist yet.
fn split_new_dir(path: &str) -> Option<(&str, &str)> {
    let trimmed = path.trim().trim_end_matches(['/', '\\']);
    let index = trimmed.rfind(['/', '\\'])?;
    let head = &trimmed[..index];
    let tail = &trimmed[index + 1..];
    if tail.is_empty() {
        return None;
    }
    if head.is_empty() {
        // `/thing`: the parent is the root.
        return trimmed.starts_with(['/', '\\']).then_some(("/", tail));
    }
    Some((head, tail))
}

/// Resolve a directory that does not exist yet but will once the command finishes.
///
/// The parent must already exist (git will not create intermediate directories) and
/// gets registered as authorized: a path the user typed is itself the authorization,
/// the same rule as adding a path on the projects page. Returns (git-side path,
/// host-side path).
fn resolve_new_dir(
    registry: &WorkspaceRegistry,
    path: &str,
    workspace: &WorkspaceEnv,
) -> Result<(String, std::path::PathBuf)> {
    let raw = path.trim();
    if raw.is_empty() || raw.starts_with('-') {
        return Err(GitError::InvalidPath(raw.to_string()));
    }
    let (parent_git, name) =
        split_new_dir(raw).ok_or_else(|| GitError::InvalidPath(raw.to_string()))?;

    let parent_host = resolve_path(parent_git, workspace);
    if !parent_host.is_dir() {
        return Err(GitError::NotADirectory(parent_git.to_string()));
    }
    let parent_local = registry
        .canonicalize_cached(&parent_host)
        .map_err(GitError::Io)?;
    registry.authorize(&parent_local).map_err(GitError::Io)?;

    // WSL paths are Linux-shaped, so use them as-is; on the host use the canonical host
    // path (git accepts `/` either way).
    let parent_for_git = if workspace.is_wsl() {
        parent_git.to_string()
    } else {
        display_path(&parent_local)
    };
    let target_git = format!("{}/{}", parent_for_git.trim_end_matches('/'), name);
    Ok((target_git, parent_local.join(name)))
}

/// Create a branch; with `switch` set, switch to it right away
/// (`git checkout -b`).
///
/// `start_point` may be a branch name or a commit id; leave it empty to start from the
/// current HEAD.
pub fn create_branch(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
    name: &str,
    start_point: Option<&str>,
    switch: bool,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let name = check_ref(name)?;
    let start = start_point.map(check_ref).transpose()?;

    let mut args: Vec<OsString> = if switch {
        vec!["checkout".into(), "-b".into(), name.into()]
    } else {
        vec!["branch".into(), name.into()]
    };
    if let Some(start) = start {
        args.push(start.into());
    }

    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git branch create failed")
}

/// Delete a branch. `force` uses `-D`: unmerged commits are discarded too, so the
/// caller must confirm first.
pub fn delete_branch(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
    name: &str,
    force: bool,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let name = check_ref(name)?;
    let flag = if force { "-D" } else { "-d" };

    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["branch", flag, &name],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git branch delete failed")
}

/// Rename a branch. The current branch can be renamed too
/// (`git branch -m <old> <new>`).
pub fn rename_branch(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
    from: &str,
    to: &str,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let from = check_ref(from)?;
    let to = check_ref(to)?;

    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["branch", "-m", &from, &to],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git branch rename failed")
}

/// Create a worktree.
///
/// With `create_new_branch` a new branch is created there (`-b`), otherwise an existing
/// branch is checked out into it; git refuses a branch already checked out elsewhere
/// and that error is passed through. Returns the new worktree's path.
pub fn worktree_add(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
    path: &str,
    branch: &str,
    create_new_branch: bool,
    start_point: Option<&str>,
) -> Result<String> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let branch = check_ref(branch)?;
    let start = start_point.map(check_ref).transpose()?;
    let (target_git, target_host) = resolve_new_dir(registry, path, workspace)?;

    let mut args: Vec<OsString> = vec!["worktree".into(), "add".into()];
    if create_new_branch {
        args.push("-b".into());
        args.push(branch.into());
        args.push(target_git.clone().into());
        if let Some(start) = start {
            args.push(start.into());
        }
    } else {
        args.push(target_git.clone().into());
        args.push(branch.into());
    }

    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git worktree add failed")?;

    // The new directory must be openable from here too; a failed registration does not
    // fail the operation, since the frontend authorizes it again.
    let _ = registry.authorize(&target_host);
    Ok(target_git)
}

/// Remove a worktree. git refuses when the directory has changes; `force` is the
/// explicit "yes, delete it anyway".
pub fn worktree_remove(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
    path: &str,
    force: bool,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let raw = path.trim();
    if raw.is_empty() || raw.starts_with('-') {
        return Err(GitError::InvalidPath(raw.to_string()));
    }
    let target = if workspace.is_wsl() {
        raw.replace('\\', "/")
    } else {
        raw.to_string()
    };

    let mut args: Vec<&str> = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push("--");
    args.push(&target);

    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git worktree remove failed")
}

/// Cherry-pick a commit onto the current branch (`git cherry-pick`). On conflict git
/// stops and reports its own message; the user can leave that in-between state with
/// `abort_operation`.
pub fn cherry_pick(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
    sha: &str,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::InvalidRefName(sha.to_string()));
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["cherry-pick", sha],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git cherry-pick failed")
}

/// Revert a commit (`git revert --no-edit`): produces an inverse commit of its own.
pub fn revert_commit(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
    sha: &str,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::InvalidRefName(sha.to_string()));
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["revert", "--no-edit", sha],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git revert failed")
}

/// Soft reset: move the branch pointer back to a commit, leaving worktree and index
/// untouched (`git reset --soft`).
pub fn reset_soft(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
    sha: &str,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::InvalidRefName(sha.to_string()));
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["reset", "--soft", sha],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git reset --soft failed")
}

/// Abort a stuck cherry-pick or revert (after a conflict git stays in an
/// in-between state that only `--abort` leaves).
pub fn abort_operation(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
    kind: &str,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let subcommand = match kind {
        "cherry-pick" => "cherry-pick",
        "revert" => "revert",
        other => return Err(GitError::InvalidRefName(other.to_string())),
    };
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        [subcommand, "--abort"],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git abort failed")
}

/// Clone a new repository into `dest`.
///
/// The target directory may not exist yet; the parent must exist and is registered as
/// authorized (a path the user typed is itself the authorization). Returns the target
/// path as seen from `workspace`, which the caller can open once authorized.
pub fn clone_repo(
    registry: &WorkspaceRegistry,
    url: &str,
    dest: &str,
    workspace: &WorkspaceEnv,
) -> Result<String> {
    ensure_git_available(workspace)?;
    let url = check_clone_url(url)?;
    let (target_git, target_host) = resolve_new_dir(registry, dest, workspace)?;

    // No cwd: the target is an absolute path, so it does not matter where we run.
    let output = run_git(
        workspace,
        None,
        ["clone", "--", &url, &target_git],
        CLONE_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git clone failed")?;

    let _ = registry.authorize(&target_host);
    Ok(target_git)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file_at(path: &str, index: char, worktree: char) -> GitChangedFile {
        GitChangedFile {
            path: path.to_string(),
            original_path: None,
            index_status: index.to_string(),
            worktree_status: worktree.to_string(),
            staged: index != ' ',
            unstaged: worktree != ' ',
            untracked: index == '?' && worktree == '?',
            status_label: String::new(),
            added: None,
            removed: None,
        }
    }

    #[test]
    fn a_failed_numstat_read_leaves_the_files_without_numbers() {
        // The status must survive a numstat read that answers nothing (a git that timed out, a repo
        // mid-rebase): the rows stay, they just carry no numbers.
        let applied = with_line_counts(vec![file_at("src/a.ts", 'M', 'M')], None);
        assert_eq!(applied[0].path, "src/a.ts");
        assert_eq!(applied[0].added, None);
        assert_eq!(applied[0].removed, None);
    }

    #[test]
    fn counts_are_attached_to_the_path_the_status_reports() {
        let mut counts = HashMap::new();
        counts.insert("src/a.ts".to_string(), (7u32, 2u32));
        let applied = with_line_counts(vec![file_at("src/a.ts", 'M', 'M')], Some(counts));
        assert_eq!(applied[0].added, Some(7));
        assert_eq!(applied[0].removed, Some(2));
    }

    #[test]
    fn a_file_the_read_does_not_mention_keeps_no_numbers() {
        // A path that only `git status` knows about (an untracked file, a mode-only change) has no
        // entry in the map, and must not be handed a made-up `+0 -0`.
        let mut counts = HashMap::new();
        counts.insert("src/other.ts".to_string(), (1u32, 0u32));
        let applied = with_line_counts(vec![file_at("src/a.ts", 'M', 'M')], Some(counts));
        assert_eq!(applied[0].added, None);
        assert_eq!(applied[0].removed, None);
    }

    #[test]
    fn merge_numstat_sums_a_path_the_two_reads_both_report() {
        let mut out = HashMap::new();
        // An ordinary modification, from `git diff --numstat`.
        merge_numstat(&mut out, b"3\t1\tsrc/a.ts\0");
        // The same path again from `git diff --cached --numstat`: staged and then edited further,
        // which is one file's difference from HEAD and has to read as one number.
        merge_numstat(&mut out, b"2\t4\tsrc/a.ts\0");
        assert_eq!(out.get("src/a.ts"), Some(&(5, 5)));
    }

    #[test]
    fn merge_numstat_keys_a_rename_by_its_new_path() {
        let mut out = HashMap::new();
        // `-z` puts a rename's two paths in their own tokens: the original, then the new one. The
        // status reports the new path, so that is the key the counts have to land on.
        merge_numstat(&mut out, b"5\t0\t\0src/old.ts\0src/new.ts\0");
        assert_eq!(out.get("src/new.ts"), Some(&(5, 0)));
        assert_eq!(out.get("src/old.ts"), None);
    }

    #[test]
    fn merge_numstat_leaves_binary_files_out() {
        // git reports "-" for both counts. Zero added lines is a different fact from "cannot be
        // counted", and a row showing "+0" for a PNG would be wrong.
        let mut out = HashMap::new();
        merge_numstat(&mut out, b"-\t-\tassets/logo.png\0");
        assert!(out.is_empty());
    }

    #[test]
    fn merge_numstat_ignores_an_empty_read() {
        let mut out = HashMap::new();
        merge_numstat(&mut out, b"");
        merge_numstat(&mut out, b"\0\0");
        assert!(out.is_empty());
    }

    #[test]
    fn sha_is_safe_accepts_hex() {
        assert!(sha_is_safe("abc123"));
        assert!(sha_is_safe(&"a".repeat(40)));
        assert!(sha_is_safe(&"f".repeat(64)));
    }

    #[test]
    fn sha_is_safe_rejects_non_hex_or_oversize() {
        assert!(!sha_is_safe(""));
        assert!(!sha_is_safe("abcg"));
        assert!(!sha_is_safe("abc 123"));
        assert!(!sha_is_safe(&"a".repeat(65)));
        assert!(!sha_is_safe(";rm -rf /"));
    }

    #[test]
    fn check_ref_trims_names_and_takes_them_as_they_come() {
        assert_eq!(check_ref("  feature/x  ").unwrap(), "feature/x");
        assert_eq!(check_ref("主题").unwrap(), "主题");
    }

    #[test]
    fn check_ref_rejects_empty_and_option_like_names() {
        for bad in ["", "   ", "-D", "--force", "-"] {
            let err = check_ref(bad).expect_err("should be rejected");
            assert!(
                matches!(err, GitError::InvalidRefName(_)),
                "{bad:?} gave {err:?}"
            );
        }
    }

    #[test]
    fn check_clone_url_accepts_the_forms_git_accepts() {
        for good in [
            "https://github.com/Zomcxj/Verta.git",
            "git@github.com:Zomcxj/Verta.git",
            "F:/VibeCoding_workspace/Verta",
        ] {
            assert_eq!(check_clone_url(good).unwrap(), good);
        }
    }

    #[test]
    fn check_clone_url_rejects_blank_option_like_and_whitespace() {
        for bad in ["", "  ", "-u", "https://x y/", "https://x/\ny"] {
            let err = check_clone_url(bad).expect_err("should be rejected");
            assert!(err.to_string().contains("git clone"), "{bad:?} gave {err}");
        }
    }

    #[test]
    fn split_new_dir_pulls_the_parent_and_the_leaf_apart() {
        assert_eq!(split_new_dir("F:/code/thing"), Some(("F:/code", "thing")));
        assert_eq!(
            split_new_dir("C:\\code\\thing"),
            Some(("C:\\code", "thing"))
        );
        assert_eq!(
            split_new_dir("/home/me/thing/"),
            Some(("/home/me", "thing"))
        );
        // For a path directly under the root, the parent is the root.
        assert_eq!(split_new_dir("/thing"), Some(("/", "thing")));
    }

    #[test]
    fn split_new_dir_needs_a_parent_and_a_leaf() {
        assert_eq!(split_new_dir("thing"), None);
        assert_eq!(split_new_dir(""), None);
        // Root only: there is no leaf to take.
        assert_eq!(split_new_dir("/"), None);
        assert_eq!(split_new_dir("C:\\"), None);
    }

    #[test]
    fn resolve_new_dir_needs_an_existing_parent_and_authorizes_it() {
        let base = std::env::temp_dir().join(format!("verta-resolve-{}", std::process::id()));
        std::fs::create_dir_all(&base).expect("temp dir");
        let registry = WorkspaceRegistry::default();
        let workspace = WorkspaceEnv::Local;

        // Missing parent: say which level is missing instead of letting git complain
        // later.
        let missing = base.join("nope").join("child");
        let err = resolve_new_dir(&registry, &missing.to_string_lossy(), &workspace)
            .expect_err("missing parent");
        assert!(err.to_string().contains("not a directory"), "{err}");

        // Parent exists: build the target and register it as authorized.
        let target = base.join("child");
        let (git_path, host_path) =
            resolve_new_dir(&registry, &target.to_string_lossy(), &workspace).expect("resolve");
        assert!(host_path.ends_with("child"), "{host_path:?}");
        assert!(git_path.ends_with("/child"), "{git_path}");
        let canonical_base = std::fs::canonicalize(&base).expect("canonical base");
        assert!(registry.is_authorized(&canonical_base));

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn is_remote_name_char_allows_word_and_punct() {
        for c in "abcXYZ012-_.".chars() {
            assert!(is_remote_name_char(c));
        }
        for c in " /:\\?\"'".chars() {
            assert!(!is_remote_name_char(c));
        }
    }

    #[test]
    fn parse_shortstat_pulls_three_counts() {
        let line = " 5 files changed, 12 insertions(+), 3 deletions(-)";
        assert_eq!(parse_shortstat(line), (5, 12, 3));
    }

    #[test]
    fn parse_shortstat_handles_singular_file() {
        let line = " 1 file changed, 1 insertion(+)";
        assert_eq!(parse_shortstat(line), (1, 1, 0));
    }

    #[test]
    fn parse_shortstat_returns_zeros_when_absent() {
        assert_eq!(parse_shortstat("no stat here"), (0, 0, 0));
    }

    #[test]
    fn status_label_for_known_chars() {
        assert_eq!(status_label_for('A'), "Added");
        assert_eq!(status_label_for('M'), "Modified");
        assert_eq!(status_label_for('D'), "Deleted");
        assert_eq!(status_label_for('R'), "Renamed");
        assert_eq!(status_label_for('C'), "Copied");
    }

    #[test]
    fn status_label_for_unknown_falls_back() {
        assert_eq!(status_label_for('X'), "Status X");
    }

    #[test]
    fn looks_like_no_head_recognizes_phrases() {
        let mk = |s: &str| GitOutput {
            stdout: Vec::new(),
            stderr: s.as_bytes().to_vec(),
            exit_code: Some(128),
            timed_out: false,
            truncated: false,
        };
        assert!(looks_like_no_head(&mk(
            "fatal: ambiguous argument 'HEAD': unknown revision"
        )));
        assert!(looks_like_no_head(&mk(
            "fatal: your current branch 'main' does not have any commits yet"
        )));
        assert!(!looks_like_no_head(&mk("fatal: pathspec did not match")));
    }
}
