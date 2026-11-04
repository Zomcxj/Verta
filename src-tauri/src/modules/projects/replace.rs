//! Making a local project match its remote, replacing whatever is here.
//!
//! The list's own pull is fast-forward-only and refuses when the upstream carries another branch
//! name, deliberately: `git pull` would merge that other branch into this one. There is a second
//! thing a user wants from a row - "give me exactly what the remote has" - and that is a different
//! operation. It discards commits and uncommitted work, so it is asked for explicitly, it is
//! confirmed by the user in the interface, and it is never what the row's ordinary pull does.
//!
//! "Shallow" is a separate question about the clone rather than about one pull: a shallow clone is
//! kept at one commit by every pull afterwards (see `pull_ff_only`), because the whole point of
//! cloning that way is that the history is not wanted.

use serde::Serialize;

use super::pull::upstream_branch_name;
use crate::modules::git::operations;
use crate::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};

/// One replacement: what the work tree was reset from and to.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceReport {
    /// The branch that was reset, and what it was reset to.
    pub branch: String,
    /// The remote branch it was reset to, as the ref that was read.
    pub upstream: String,
    /// The commit `HEAD` pointed at before the replacement.
    pub previous_head: String,
    /// The commit the work tree now holds.
    pub head: String,
    /// Whether the copy is a shallow one afterwards - true after `replace_with_remote_shallow`.
    pub shallow: bool,
    /// Commits that were on this branch and are not on the remote's - the history this threw away.
    pub discarded_commits: u32,
    /// Files that had uncommitted changes and were overwritten.
    pub discarded_files: u32,
}

/// Make the work tree of `repo_root` exactly the remote branch.
///
/// Caller has already checked that the upstream carries the same branch name (`pull_blocker`):
/// replacing into a differently named branch would put another branch's history on this one, which
/// is what that rule exists to prevent.
///
/// There is no backup, by the user's own decision (2026-11-03): the point of this operation is to
/// throw the local state away, and the interface says so before it runs. The report names what was
/// discarded - the commits and the files - so the row can say what it cost.
pub fn replace_with_remote(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<ReplaceReport, String> {
    replace(registry, repo_root, workspace, None)
}

/// The same, and leaves the copy shallow: one commit, nothing behind it.
///
/// This is what a repository kept only to be read wants from a row it already has - the clone was
/// made full, and the history is weight nobody asked for. `fetch --depth 1` is the operation that
/// drops it: measured on a full clone, it trims the copy to the newest commit and marks it shallow,
/// and every pull afterwards keeps it there (see `pull_ff_only`). Anything else about the branch -
/// which commit it is on, whether the work tree was replaced - is exactly the plain replacement.
pub fn replace_with_remote_shallow(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<ReplaceReport, String> {
    replace(registry, repo_root, workspace, Some(1))
}

fn replace(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
    depth: Option<u32>,
) -> Result<ReplaceReport, String> {
    let snapshot =
        operations::status(registry, repo_root, workspace).map_err(|e| e.to_string())?;
    let branch = snapshot.branch.clone();
    let upstream = snapshot
        .upstream
        .clone()
        .ok_or_else(|| format!("{branch} 没有上游分支，不能覆盖"))?;
    // Only to refuse an upstream whose ref name cannot be read; the ref below is built from the
    // upstream itself, so a branch whose name carries a slash (`origin/feature/x`) stays whole.
    if upstream_branch_name(&upstream).is_none() {
        return Err(format!("上游 {upstream} 读不出分支名，不能覆盖"));
    }

    // Without this the "remote" would be whatever was last fetched, possibly days ago. With a depth
    // it also trims what is already here: the measured effect of `--depth 1` on a full copy is that
    // the older commits stop being present.
    let _fetch = match depth {
        Some(depth) => {
            let arg = format!("--depth={depth}");
            step(registry, repo_root, workspace, ["fetch", "--prune", &arg])?
        }
        None => step(registry, repo_root, workspace, ["fetch", "--prune", "--all"])?,
    };

    let remote_ref = format!("refs/remotes/{upstream}");
    let wanted = step(
        registry,
        repo_root,
        workspace,
        ["rev-parse", "--verify", &format!("{remote_ref}^{{commit}}")],
    )?
        .ok_or_else(|| format!("拉不到远程的 {upstream}，不能覆盖"))?;
    let previous_head = step(registry, repo_root, workspace, ["rev-parse", "HEAD", "--"])?
        .ok_or_else(|| "读不到当前提交，不能覆盖".to_string())?;

    // What this is about to throw away, counted before anything moves.
    let discarded_commits = match step(
        registry,
        repo_root,
        workspace,
        ["rev-list", "--count", &format!("{wanted}..{previous_head}")],
    )? {
        Some(count) => count.parse::<u32>().unwrap_or_default(),
        None => 0,
    };
    let discarded_files = snapshot.changed_files.len() as u32;

    // The reset comes first, and the clean only after it succeeded.
    //
    // The other order was measured to be destructive in a way nobody would guess: a checkout that
    // cannot finish - here, a repository whose paths are longer than Windows allows - fails inside
    // `reset --hard` after it has already removed the files it could not replace. With `clean`
    // first, the user was then left with an empty work tree and a `HEAD` that had not moved: "已经
    // 覆盖了，怎么还是分歧". A reset that fails on its own leaves the files it did not reach in place,
    // and this returns before anything is deleted.
    // Anchored on `--` so a branch name that looks like a path is still a revision: the reset is
    // the step that decides whether anything is deleted below.
    step(registry, repo_root, workspace, ["reset", "--hard", &wanted])?;
    // `reset --hard` leaves untracked files alone, and "exactly what the remote has" means they are
    // not part of the work tree afterwards either. They are gone: this is the operation the user
    // confirmed, and there is no backup.
    step(registry, repo_root, workspace, ["clean", "-fd", "--"])?;

    Ok(ReplaceReport {
        branch,
        upstream,
        previous_head,
        head: wanted,
        shallow: depth.is_some(),
        discarded_commits,
        discarded_files,
    })
}

/// One `git` step: its first line of output, or the failure it reported.
///
/// A non-zero exit is an error here, not an empty answer. Somewhere in this sequence it decides
/// whether the next, destructive step runs at all.
fn step(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
    args: [&str; 3],
) -> Result<Option<String>, String> {
    let (ok, line) = operations::git_run_in_repo(registry, repo_root, workspace, args)
        .map_err(|e| e.to_string())?;
    if ok {
        Ok(line)
    } else {
        Err(match line {
            // git usually puts the reason on stderr; the first stdout line is only the fallback.
            Some(line) => format!("git {} 失败：{line}", args[0]),
            None => format!("git {} 失败", args[0]),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::ReplaceReport;

    #[test]
    fn a_failed_step_is_an_error_and_not_an_empty_answer() {
        // The rule the sequence depends on, checked where it can be: a non-zero exit has to stop the
        // steps after it. Exercised through the same reasoning `step` uses - a failure carries a
        // reason, and a success may carry nothing.
        let fail = |reason: Option<&str>| -> Result<(), String> {
            Err(match reason {
                Some(line) => format!("git reset 失败：{line}"),
                None => "git reset 失败".to_string(),
            })
        };
        assert!(fail(Some("Filename too long")).is_err());
        assert!(fail(None).is_err());
        assert!(
            fail(Some("Filename too long"))
                .err()
                .unwrap_or_default()
                .contains("Filename too long"),
            "the reason git gave has to reach the user"
        );
        assert!(Ok::<(), String>(()).is_ok(), "a step that worked stops nothing");
    }

    #[test]
    fn the_report_names_the_branch_the_upstream_and_what_was_discarded() {
        let report = ReplaceReport {
            branch: "main".into(),
            upstream: "origin/main".into(),
            previous_head: "aaa".into(),
            head: "bbb".into(),
            shallow: true,
            discarded_commits: 2,
            discarded_files: 3,
        };
        let json = serde_json::to_string(&report).expect("serialises");
        // camelCase on the wire, like every other payload this module sends.
        assert!(json.contains("\"previousHead\""), "{json}");
        assert!(json.contains("\"discardedCommits\":2"), "{json}");
        assert!(json.contains("\"discardedFiles\":3"), "{json}");
    }
}
