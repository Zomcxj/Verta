//! The rule behind pulling one project from the list: a pull is only allowed when the
//! branch being pulled into carries the same name as its upstream.
//!
//! `git pull` merges the upstream into the current branch. For `main` tracking
//! `origin/main` that is exactly what the user asked for; for `work` tracking
//! `origin/main` the same command would merge another branch into this one, so it is
//! refused here and the reason is spelled out instead.

/// Branch name carried by an upstream ref: `origin/main` -> `main`,
/// `origin/feature/login` -> `feature/login`.
///
/// The first segment is the remote's name and the rest is the branch, so a branch whose
/// own name contains a slash still comes back whole. A local branch tracking another local
/// branch has no remote segment and is returned unchanged. None for an empty value (or a
/// bare `origin/`).
pub fn upstream_branch_name(upstream: &str) -> Option<&str> {
    let trimmed = upstream.trim();
    if trimmed.is_empty() {
        return None;
    }
    match trimmed.split_once('/') {
        Some((_, branch)) if !branch.trim().is_empty() => Some(branch),
        Some(_) => None,
        None => Some(trimmed),
    }
}

/// Why this project cannot be pulled right now; None means go ahead.
pub fn pull_blocker(branch: Option<&str>, upstream: Option<&str>, detached: bool) -> Option<String> {
    if detached {
        return Some("当前是 detached HEAD，不在任何分支上，不能拉取".to_string());
    }
    let Some(branch) = branch.map(str::trim).filter(|b| !b.is_empty()) else {
        return Some("读不到当前分支，不能拉取".to_string());
    };
    let Some(upstream) = upstream.map(str::trim).filter(|u| !u.is_empty()) else {
        return Some(format!("{branch} 没有上游分支，不能拉取"));
    };
    match upstream_branch_name(upstream) {
        Some(name) if name == branch => None,
        Some(name) => Some(format!(
            "上游是 {upstream}（分支 {name}），和当前分支 {branch} 不同名，不能拉取"
        )),
        None => Some(format!("上游 {upstream} 读不出分支名，不能拉取")),
    }
}

#[cfg(test)]
mod tests {
    use super::{pull_blocker, upstream_branch_name};

    #[test]
    fn an_upstream_ref_is_stripped_of_its_remote() {
        assert_eq!(upstream_branch_name("origin/main"), Some("main"));
        assert_eq!(upstream_branch_name("upstream/main"), Some("main"));
        assert_eq!(upstream_branch_name("  origin/main  "), Some("main"));
    }

    #[test]
    fn a_branch_name_with_a_slash_comes_back_whole() {
        // The remote is the first segment; everything after it is the branch.
        assert_eq!(
            upstream_branch_name("origin/feature/login"),
            Some("feature/login")
        );
        assert_eq!(upstream_branch_name("origin/origin/main"), Some("origin/main"));
    }

    #[test]
    fn a_local_upstream_and_junk_have_no_remote_segment() {
        assert_eq!(upstream_branch_name("main"), Some("main"));
        assert_eq!(upstream_branch_name("origin/"), None);
        assert_eq!(upstream_branch_name(""), None);
        assert_eq!(upstream_branch_name("   "), None);
    }

    #[test]
    fn the_same_name_on_both_sides_is_the_only_go_ahead() {
        assert_eq!(pull_blocker(Some("main"), Some("origin/main"), false), None);
        assert_eq!(
            pull_blocker(Some("feature/login"), Some("origin/feature/login"), false),
            None
        );
    }

    #[test]
    fn a_differently_named_upstream_is_refused_and_both_names_are_named() {
        let reason = pull_blocker(Some("work"), Some("origin/main"), false)
            .expect("不同名应该被拦下");
        assert!(reason.contains("origin/main"), "实际：{reason}");
        assert!(reason.contains("main"), "实际：{reason}");
        assert!(reason.contains("work"), "实际：{reason}");
    }

    #[test]
    fn detached_or_missing_information_is_refused_too() {
        assert!(pull_blocker(Some("main"), Some("origin/main"), true).is_some());
        assert!(pull_blocker(Some("  "), Some("origin/main"), false).is_some());
        assert!(pull_blocker(None, Some("origin/main"), false).is_some());
        assert!(pull_blocker(Some("main"), None, false).is_some());
        assert!(pull_blocker(Some("main"), Some(""), false).is_some());
        assert!(pull_blocker(Some("main"), Some("origin/"), false).is_some());
    }
}