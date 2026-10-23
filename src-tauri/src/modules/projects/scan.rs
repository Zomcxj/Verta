//! Project directory scan: given a root, find the git repositories a few levels below it.
//!
//! Purely filesystem-based (a `.git` is enough, directory or file: the latter means a
//! worktree or submodule) and never spawns git, so it is fast and directly testable
//! against temp directories.

use std::path::Path;

/// No repository root the user cares about lives under these names; skipping them speeds
/// the scan up by an order of magnitude.
const SKIP_DIRS: [&str; 6] = ["node_modules", "target", ".venv", "venv", "dist", "build"];

/// Find the repository roots under `root`, sorted by path.
///
/// `max_depth` is how many levels below `root` may still be a repository root: 0 means
/// only `root` itself, 1 its direct children, and so on. Descent stops at a hit: a
/// repository nested inside one (a submodule, say) is added explicitly by the user, so the
/// list does not fill up with a single project's internal directories.
pub fn discover_git_repos(root: &Path, max_depth: usize) -> Vec<String> {
    let mut found = Vec::new();
    if has_git(root) {
        found.push(display(root));
        return found;
    }
    walk(root, 1, max_depth, &mut found);
    found.sort_by_key(|path| path.to_lowercase());
    found.dedup();
    found
}

fn walk(dir: &Path, depth: usize, max_depth: usize, found: &mut Vec<String>) {
    if depth > max_depth {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        // An unreadable directory (permissions, dead drive letter) does not abort the scan;
        // just skip it.
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // All hidden directories are skipped: .git itself, and things like .cache / .venv.
        if name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()) {
            continue;
        }
        let path = entry.path();
        // Do not follow symlinks: a directory may link back to a parent and loop forever.
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        if has_git(&path) {
            found.push(display(&path));
            continue;
        }
        walk(&path, depth + 1, max_depth, found);
    }
}

fn has_git(dir: &Path) -> bool {
    // In worktrees and submodules `.git` is a file, so only existence matters.
    dir.join(".git").exists()
}

fn display(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// A temporary directory, removed on Drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let mut path = std::env::temp_dir();
            let unique = format!(
                "verta-scan-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            );
            path.push(unique.replace(['(', ')', ' '], ""));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn make_repo(dir: &Path) {
        fs::create_dir_all(dir).expect("create repo dir");
        fs::create_dir_all(dir.join(".git")).expect("create .git");
    }

    #[test]
    fn finds_the_root_itself() {
        let temp = TempDir::new("root");
        make_repo(temp.path());
        let found = discover_git_repos(temp.path(), 2);
        assert_eq!(found, vec![temp.path().to_string_lossy().to_string()]);
    }

    #[test]
    fn respects_the_depth_limit() {
        let temp = TempDir::new("depth");
        // Three non-nested chains, each exercising one depth; the middle levels are
        // deliberately not repositories, so the "stop descending at a hit" rule does not
        // kick in.
        make_repo(&temp.path().join("one"));
        make_repo(&temp.path().join("a").join("two"));
        make_repo(&temp.path().join("x").join("y").join("three"));

        let found = discover_git_repos(temp.path(), 2);
        let names: Vec<String> = found.iter().map(|p| p.to_lowercase()).collect();
        assert!(
            names.iter().any(|p| p.ends_with("one")),
            "第 1 层应被找到：{names:?}"
        );
        assert!(
            names.iter().any(|p| p.ends_with("two")),
            "第 2 层应被找到：{names:?}"
        );
        assert!(
            !names.iter().any(|p| p.ends_with("three")),
            "第 3 层超出深度，不该被找到：{names:?}"
        );
    }

    #[test]
    fn counts_a_dot_git_file_as_a_repo() {
        let temp = TempDir::new("worktree");
        let worktree = temp.path().join("wt");
        fs::create_dir_all(&worktree).expect("create worktree dir");
        fs::write(worktree.join(".git"), "gitdir: /elsewhere/.git\n").expect("write .git file");

        let found = discover_git_repos(temp.path(), 2);
        assert_eq!(found.len(), 1, "worktree 的 .git 是文件，也要算仓库：{found:?}");
    }

    #[test]
    fn skips_hidden_and_heavy_directories() {
        let temp = TempDir::new("skip");
        make_repo(&temp.path().join(".hidden"));
        make_repo(&temp.path().join("node_modules").join("pkg"));
        make_repo(&temp.path().join("target").join("debug"));
        make_repo(&temp.path().join("keep"));

        let found = discover_git_repos(temp.path(), 2);
        assert_eq!(found.len(), 1, "只应剩下 keep：{found:?}");
        assert!(found[0].ends_with("keep"));
    }

    #[test]
    fn does_not_descend_into_a_found_repo() {
        let temp = TempDir::new("nested");
        let outer = temp.path().join("outer");
        make_repo(&outer);
        make_repo(&outer.join("inner"));

        let found = discover_git_repos(temp.path(), 3);
        assert_eq!(found.len(), 1, "嵌套仓库要用户显式添加：{found:?}");
        assert!(found[0].ends_with("outer"));
    }

    #[test]
    fn a_missing_root_yields_nothing() {
        let temp = TempDir::new("missing");
        let nowhere = temp.path().join("does-not-exist");
        assert!(discover_git_repos(&nowhere, 2).is_empty());
    }
}