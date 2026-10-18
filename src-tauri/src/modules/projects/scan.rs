//! 项目目录扫描：给一个根目录，找出它下面若干层以内的 git 仓库。
//!
//! 只做纯文件系统判定（看到 `.git` 就算，是目录还是文件都行，后者是 worktree 或子模块），
//! 不启动 git 进程，所以又快又能在单测里用临时目录直接验。

use std::path::Path;

/// 这些目录名下面不会是用户想管的仓库根，跳过能让扫描快一个数量级。
const SKIP_DIRS: [&str; 6] = ["node_modules", "target", ".venv", "venv", "dist", "build"];

/// 找出 `root` 之下的仓库根，按路径排序返回。
///
/// `max_depth` 是「允许成为仓库根的目录相对 root 的层数」：0 表示只有 root 自己，
/// 1 表示 root 的直接子目录，依此类推。命中仓库后不再往下走：嵌套在仓库里的另一个仓库
/// （子模块之类）由用户显式添加，免得一屏里塞满同一个项目的内部目录。
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
        // 读不动的目录（权限、盘符失效）不中断整次扫描，如实跳过。
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // 隐藏目录一律跳过：既有 .git 自身，也有 .cache / .venv 这类。
        if name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()) {
            continue;
        }
        let path = entry.path();
        // 不跟随符号链接：目录里可能有指回上层的链接，跟随就会绕圈。
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
    // worktree 与子模块的 `.git` 是文件，所以只看存在性。
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

    /// 临时目录，Drop 时删掉。
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
        // 三条互不嵌套的链，各自验一层深度；中间层故意不是仓库，
        // 免得被「命中仓库就不再下潜」的规则挡住。
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