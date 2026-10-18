# Verta P1.5（会话管理：真删除 + 多选）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给会话一个管理界面：能看到全部会话（含子代理），多选后**真正删除数据**（不是隐藏）。

**Architecture:** 删除一律在 Rust 侧执行，前端**只传 `{tool, id}`**。opencode 走它自带的 `opencode session delete <id>`（由它负责级联与后台服务状态，绝不自己写 SQL 动那 5.6 GB 的 WAL 库）；pi 没有删除命令，按扫描结果删除它的会话文件与同名产物目录。两者都在删除后**重新扫描确认**，`deleted` 只在复核通过时才为真。

**Tech Stack:** Tauri 2 / Rust（复用既有 `proc::capture` 有界进程运行器）/ React 19 / TypeScript / vitest

---

## 0. 已核实的事实（都在本机真机验证过，不是推测）

| 事实 | 证据 |
|---|---|
| opencode 自带删除命令 | `opencode session --help` 列出 `delete  Delete a session and its child sessions`；用法 `opencode session delete [flags] <sessionID>`（**没有 directory 参数**） |
| opencode 对未知 id 的报错 | `opencode session delete ses_vertaprobe_nonexistent` 输出 `Session not found: ses_vertaprobe_nonexistent`，无副作用（`session_v2` 仍 18 行） |
| opencode 有 export / import | `opencode session export [<session>]`、`opencode session import <file>`；import 对已存在的 id 幂等（输出 `Session already exists`，行数不变） |
| pi 没有删除机制 | `pi --help` 只有 install / remove / uninstall / update / list / config / auth / mcp，无会话管理 |
| pi 的布局（本机实测） | 会话本体是 `<pi root>/<编码cwd>/<ISO>_<uuid>.jsonl`；**可能**存在同名目录 `<ISO>_<uuid>/`，里面装该会话的子代理产物目录（ModelHarbor 那条有 52 项）与 `forks/*.jsonl`；WorkBuddy / portfolio 的会话文件没有同名目录；`subagent-artifacts` 是**共享**目录，任何情况都不许碰 |\n| pi 的 fork 真实位置（本次修正） | 完整形态是 `<root>/<编码cwd>/<ISO>_<uuid>.jsonl` + `<root>/<编码cwd>/<ISO>_<uuid>/{<运行uuid>/run-0/..., forks/<ISO>_<uuid>.jsonl}`。**本机不存在 `<项目>/forks/`**，而 `pi.rs` 原来找的正是那一层，所以那 2 条 fork 会话从未被列出来过（见 Task 0）。`forks` 是 forks 唯一所在层，再深就不是会话 |\n| opencode 的可执行形态（本机实测） | PATH 上是 npm 垫片 `D:\\Softwaredata\\npm-global\\opencode.cmd` → `node_modules/@opencode/cli/bin/opencode.exe`。Windows 的 `CreateProcess` **不认 `.cmd`**，所以删会话不能直接 `Command::new(\"opencode\")`，要走 `cmd /C opencode ...`（对\"真 exe\"的安装形态同样成立） |
| 前端已有的 id 白名单 | `src/modules/launcher/lib/resumeCommand.ts` 里 `SESSION_ID = /^[A-Za-z0-9_-]+$/`（opencode 的 `ses_…` 与 pi 的 uuid 都满足） |

**本机路径陷阱**：bash 的 `/tmp` 是 `%TEMP%`，而 Windows 版 python 的 `/tmp` 是 `C:\tmp`（不存在）。计划里的命令统一用 `$HOME` 或仓库内路径，测试统一用 `tempfile`。

---

## 1. 安全规则（实现必须满足，验收逐条检查）

1. **前端只传 `{tool, id}`**，命令签名里**没有任何路径参数**。路径由 Rust 自己从库或扫描结果里解析，从根上关掉"前端传路径 → 任意文件删除"。
2. **id 先过白名单**（`^[A-Za-z0-9_-]+$`）再使用；不合法直接拒绝，不做转义后放行。
3. **pi 的删除目标是扫描出来的路径**，且删除前必须确认它落在 pi root 之内（对 root 与目标都做 `canonicalize`，再比前缀）。`subagent-artifacts` 永不在目标集合里。
4. **删除后必须复核**：opencode 重新查库、pi 重新扫描；只有确认目标已不存在，`deleted` 才为 true。CLI 说成功但复核仍在 → 记为失败并说明，绝不谎报成功。
5. **一次删除前必须二次确认**（spec §5.4）：确认框要列出将删除的条数、按工具的分布、其中有多少是子代理会话，并明确写出两条连带影响（opencode 连带删除其子会话；pi 连带删除该会话的产物目录与其中的 forks）。
6. **不做静默失败**：每条的失败原因原样回传并在界面上可见。
7. **一条失败不影响其余**：多选删除逐条执行，逐条记录结果。

---

## 2. 文件结构

**Rust**

| 文件 | 改动 |
|---|---|
| `src-tauri/src/modules/agent_sessions/delete.rs` | 新增：`SessionTarget`、`DeleteOutcome`、`DeleteReport`、`validate_session_id`、命令 `agent_sessions_delete` |
| `src-tauri/src/modules/agent_sessions/opencode.rs` | 新增：`session_directory`、`exists`、`delete`（调 `opencode session delete`） |
| `src-tauri/src/modules/agent_sessions/pi.rs` | 新增：`locate`、`exists`、`delete`（删文件 + 同名产物目录） |
| `src-tauri/src/modules/agent_sessions/mod.rs` | 挂 `mod delete;`，导出命令 |
| `src-tauri/src/lib.rs` | 注册 `agent_sessions::agent_sessions_delete` |

**前端**

| 文件 | 改动 |
|---|---|
| `src/modules/launcher/lib/selection.ts` | 新增（纯函数）：选中集合的切换/全选/清空、按工具的分布、子代理计数 |
| `src/modules/launcher/lib/selection.test.ts` | 新增 |
| `src/modules/launcher/lib/sessions.ts` | 新增 `deleteAgentSessions` |
| `src/modules/launcher/lib/types.ts` | 新增 `SessionTarget`、`DeleteOutcome`、`DeleteReport` |
| `src/modules/launcher/components/SessionList.tsx` | 支持 `selectable` / `selected` / `onToggle` 与"子代理"标记 |
| `src/modules/launcher/components/LauncherPanel.tsx` | 管理态：显示全部会话、多选、底部操作条、删除确认框、结果反馈 |

---

## Task 0: 修正 pi 的 fork 扫描位置（先做，删除要复用同一套定位）

**Files:**
- Modify: `src-tauri/src/modules/agent_sessions/pi.rs`

- [x] **Step 1: 写测试（两个：真实 fork 层级 + 产物目录不算会话）**

`scans_top_level_and_forks_but_skips_non_sessions` 里 fork 的写入路径从 `<项目>/forks/` 改成 `<项目>/<stem>/forks/`；新增 `a_fork_still_lists_when_its_parent_file_is_gone`（本机真实形态：父会话文件已删、`<stem>/forks` 还在）与 `subagent_run_artifacts_are_not_sessions`（`<stem>/<uuid>/run-0/output.jsonl` 不是会话）。

- [x] **Step 2: 跑测试确认失败**

Run: `cd /f/VibeCoding_workspace/Verta/src-tauri && CARGO_BUILD_JOBS=2 cargo test -j 2 --lib agent_sessions`

实际结果：2 failed / 23 passed，两个失败都指向 fork 完全没被扫到。

- [x] **Step 3: 实现（列表与删除共用 `session_files`）**

```rust
/// The session files of one project directory: its own transcripts, plus the
/// forks of each session. pi writes a fork under `<stem>/forks` next to that
/// session's run artifacts (`<stem>/<run uuid>/run-0`), so a fork sits one
/// level deeper than the transcript it branched from; nothing deeper than
/// `forks` is a session.
fn session_files(project_dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for child in child_paths(project_dir).unwrap_or_default() {
        if child.is_dir() {
            files.extend(child_paths(&child.join("forks")).unwrap_or_default());
        } else {
            files.push(child);
        }
    }
    files.retain(|file| file.extension().and_then(|ext| ext.to_str()) == Some("jsonl"));
    files
}
```

`list_at` 的扫描循环改为 `for file in session_files(&project_dir)`（去掉原来那段 `<项目>/forks` 与扩展名过滤）。

- [x] **Step 4: 跑测试确认通过**

实际结果：25 passed / 0 failed。

- [x] **Step 5: 提交**

```bash
git commit -m "fix(agent-sessions): read pi forks from where pi writes them"
```

**连带影响**：列表会多出 2 条 pi 会话（`--F--VibeCoding_workspace-ModelHarbor--/2026-09-09T.../forks/` 下那两条），它们的 `parentSession` 文件本机已不存在，所以会作为顶层会话显示。这是真实可 resume 的会话，显示出来是对的。

---

## Task 1: 类型与 id 校验（纯函数，先写测试）

**Files:**
- Create: `src-tauri/src/modules/agent_sessions/delete.rs`
- Modify: `src-tauri/src/modules/agent_sessions/mod.rs`

- [ ] **Step 1: 写失败的测试**

`delete.rs` 先只放测试：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_two_real_id_shapes() {
        assert!(validate_session_id("ses_0be16f2c8ffeFnRn5CVN2D7Xay").is_ok());
        assert!(validate_session_id("01a147ad-023f-71ff-b404-bb337dea4b63").is_ok());
    }

    #[test]
    fn rejects_anything_that_could_escape_a_path() {
        for id in [
            "",
            "..",
            "../x",
            "..\\x",
            "a/b",
            "a\\b",
            "C:\\Windows\\system32",
            "/etc/passwd",
            "a b",
            "a\"b",
            "a'b",
            "a;b",
            "ses_x$()",
            "ses_x\n",
        ] {
            assert!(validate_session_id(id).is_err(), "should reject {id:?}");
        }
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /f/VibeCoding_workspace/Verta/src-tauri && cargo test -j 2 --lib agent_sessions`

Expected: FAIL，`cannot find function validate_session_id`。

- [ ] **Step 3: 实现类型与校验**

`delete.rs`：

```rust
use serde::{Deserialize, Serialize};

use super::types::AgentSessionsPayload;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTarget {
    pub tool: String,
    pub id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    pub tool: String,
    pub id: String,
    pub deleted: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteReport {
    pub deleted: usize,
    pub outcomes: Vec<DeleteOutcome>,
}

/// Ids reach a filesystem lookup and a process argument list, so only the shape
/// both tools actually use is let through. No escaping, no repair.
pub(crate) fn validate_session_id(id: &str) -> Result<(), String> {
    let valid = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if valid {
        Ok(())
    } else {
        Err(format!("非法的会话 id：{id}"))
    }
}
```

`mod.rs` 加 `mod delete;`（并把命令在 Task 5 里 `pub use`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /f/VibeCoding_workspace/Verta/src-tauri && cargo test -j 2 --lib agent_sessions`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd /f/VibeCoding_workspace/Verta
git add src-tauri/src/modules/agent_sessions
git commit -m "feat(agent-sessions): add delete types and the session id guard"
```

---

## Task 2: opencode 删除（走它自己的 CLI + 复核）

**Files:**
- Modify: `src-tauri/src/modules/agent_sessions/opencode.rs`

- [ ] **Step 1: 写测试**

追加到 `opencode.rs` 的 `tests`：

```rust
    #[test]
    fn builds_the_delete_command_it_documents() {
        assert_eq!(delete_arguments("ses_1"), vec!["session", "delete", "ses_1"]);
    }

    #[test]
    fn a_missing_row_is_a_clear_error() {
        let (_dir, path) = temp_db("session_v2");
        let error = session_directory(&path, "ses_nope").expect_err("should fail");
        assert!(error.contains("ses_nope"), "unexpected error: {error}");
    }

    #[test]
    fn reports_the_directory_of_an_existing_row() {
        let (_dir, path) = temp_db("session_v2");
        insert(&path, "session_v2", "ses_1", None, Some("t"), "F:/x", 1);
        assert_eq!(session_directory(&path, "ses_1").expect("dir"), "F:/x");
        assert!(exists_at(&path, "ses_1").expect("exists"));
        assert!(!exists_at(&path, "ses_2").expect("exists"));
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /f/VibeCoding_workspace/Verta/src-tauri && cargo test -j 2 --lib agent_sessions`

Expected: FAIL（`delete_arguments` / `session_directory` / `exists_at` 不存在）。

- [ ] **Step 3: 实现**

追加到 `opencode.rs`（`tests` 之外）：

```rust
use std::process::Command;
use std::time::{Duration, Instant};

use crate::modules::proc::capture::{self, Limits};
use crate::modules::proc::hide_console;

const DELETE_TIMEOUT: Duration = Duration::from_secs(30);
const DELETE_LIMITS: Limits = Limits {
    stdout: 8 * 1024,
    stderr: 8 * 1024,
    stop_on_stdout_cap: false,
};

pub(crate) fn delete_arguments(id: &str) -> Vec<&str> {
    vec!["session", "delete", id]
}

/// The CLI resolves a session against the directory it runs in, so the directory
/// is read from the database rather than accepted from the caller.
pub(crate) fn session_directory(path: &Path, id: &str) -> Result<String, String> {
    let table = session_table(path)?;
    let conn = open_read_only(path)?;
    conn.query_row(
        &format!("SELECT directory FROM {table} WHERE id = ?1"),
        [id],
        |row| row.get::<_, String>(0),
    )
    .map_err(|_| format!("opencode 里找不到会话 {id}"))
}

pub(crate) fn exists_at(path: &Path, id: &str) -> Result<bool, String> {
    let table = session_table(path)?;
    let conn = open_read_only(path)?;
    let found: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE id = ?1"),
            [id],
            |row| row.get(0),
        )
        .map_err(|e| format!("读取 opencode 会话失败：{e}"))?;
    Ok(found > 0)
}

pub(crate) fn delete(id: &str) -> Result<(), String> {
    let path = default_db_path().ok_or("找不到用户主目录，无法定位 opencode 数据库")?;
    delete_at(&path, id, Path::new("opencode"))
}

fn delete_at(db: &Path, id: &str, program: &Path) -> Result<(), String> {
    let directory = session_directory(db, id)?;
    let mut command = Command::new(program);
    command.args(delete_arguments(id)).current_dir(&directory);
    hide_console(&mut command);
    let captured = capture::run(&mut command, DELETE_TIMEOUT, DELETE_LIMITS)
        .map_err(|e| format!("无法执行 opencode session delete：{e}"))?;
    if captured.timed_out {
        return Err("删除超时（opencode 30 秒内没有返回）".to_string());
    }
    if captured.exit_code != Some(0) {
        let text = if captured.stderr.is_empty() {
            &captured.stdout
        } else {
            &captured.stderr
        };
        let text = String::from_utf8_lossy(text).trim().to_string();
        return Err(if text.is_empty() {
            format!("opencode session delete 退出码 {:?}", captured.exit_code)
        } else {
            text
        });
    }
    Ok(())
}
```

- `capture::run` 需要 `&mut Command`，`hide_console` 在 Windows 上加 `CREATE_NO_WINDOW`（这两个都是仓库既有 helper）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /f/VibeCoding_workspace/Verta/src-tauri && cargo test -j 2 --lib agent_sessions`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd /f/VibeCoding_workspace/Verta
git add src-tauri/src/modules/agent_sessions/opencode.rs
git commit -m "feat(agent-sessions): delete opencode sessions through its own cli"
```

---

## Task 3: pi 删除（扫描定位 + 删文件与同名产物目录）

**Files:**
- Modify: `src-tauri/src/modules/agent_sessions/pi.rs`

- [ ] **Step 1: 写测试**

追加到 `pi.rs` 的 `tests`：

```rust
    fn session_body(id: &str) -> String {
        format!(
            "{}\n{}\n",
            format_args!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"cwd\":\"F:\\\\VibeCoding_workspace\\\\ModelHarbor\"}}"
            ),
            r#"{"type":"session_info","name":"n"}"#
        )
    }

    #[test]
    fn deletes_the_session_file_and_its_artifact_directory_only() {
        let root = tempfile::tempdir().expect("temp dir");
        let project = root.path().join("--F--cwd--");
        let target = "01a147ad-023f-71ff-b404-bb337dea4b63";
        let file = write_file(
            &project,
            &format!("2026-10-17T02-24-43-071Z_{target}.jsonl"),
            &session_body(target),
        );
        write_file(
            &file.with_extension(""),
            "ignored",
            "",
        );
        let artifact = file.with_extension("");
        std::fs::create_dir_all(artifact.join("run-0")).expect("artifact dir");
        std::fs::write(artifact.join("run-0").join("out.txt"), "x").expect("write");
        // A sibling session and the shared directory must survive.
        let sibling = write_file(&project, "2026-10-17T03-00-00-000Z_keep.jsonl", &session_body("keep"));
        write_file(&project.join("subagent-artifacts"), "run-0.jsonl", "{}\n");

        delete_at(root.path(), target).expect("delete");

        assert!(!file.exists(), "session file should be gone");
        assert!(!artifact.exists(), "artifact directory should be gone");
        assert!(sibling.exists(), "sibling session must survive");
        assert!(project.join("subagent-artifacts").exists(), "shared dir must survive");
        assert!(!exists_at(root.path(), target).expect("exists"));
    }

    #[test]
    fn deleting_a_fork_leaves_its_parent_session_alone() {
        let root = tempfile::tempdir().expect("temp dir");
        let project = root.path().join("--F--cwd--");
        let parent = write_file(&project, "2026-10-17T02-00-00-000Z_parent.jsonl", &session_body("parent"));
        let fork = write_file(
            &project.join("forks"),
            "2026-10-17T03-00-00-000Z_fork.jsonl",
            &session_body("fork"),
        );
        delete_at(root.path(), "fork").expect("delete");
        assert!(!fork.exists());
        assert!(parent.exists());
    }

    #[test]
    fn an_unknown_id_changes_nothing() {
        let root = tempfile::tempdir().expect("temp dir");
        let project = root.path().join("--F--cwd--");
        let file = write_file(&project, "2026-10-17T02-00-00-000Z_keep.jsonl", &session_body("keep"));
        let error = delete_at(root.path(), "nope").expect_err("should fail");
        assert!(error.contains("nope"), "unexpected error: {error}");
        assert!(file.exists());
    }

    #[test]
    fn refuses_to_escape_the_root() {
        let root = tempfile::tempdir().expect("temp dir");
        std::fs::create_dir_all(root.path().join("--F--cwd--")).expect("dir");
        let outside = root.path().parent().expect("parent").join("verta-outside-probe.jsonl");
        std::fs::write(&outside, "x").expect("write");
        for id in ["..", "../verta-outside-probe", "a/b"] {
            assert!(delete_at(root.path(), id).is_err(), "should reject {id:?}");
        }
        assert!(outside.exists(), "nothing outside the root may be touched");
        let _ = std::fs::remove_file(&outside);
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /f/VibeCoding_workspace/Verta/src-tauri && cargo test -j 2 --lib agent_sessions`

Expected: FAIL（`delete_at` / `exists_at` 不存在）。

- [ ] **Step 3: 实现**

追加到 `pi.rs`：

```rust
/// Where a session id actually lives, proved by the same scan the list uses.
struct Located {
    file: PathBuf,
    /// A top-level session file owns `<stem>/`: its subagent artifacts and forks.
    owned_directory: Option<PathBuf>,
}

fn locate(root: &Path, id: &str) -> Result<Located, String> {
    for project_dir in child_paths(root)? {
        if !project_dir.is_dir() {
            continue;
        }
        let mut files = child_paths(&project_dir).unwrap_or_default();
        let fork_dir = project_dir.join("forks");
        if let Ok(forks) = child_paths(&fork_dir) {
            files.extend(forks);
        }
        for file in files {
            if file.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(Some(session)) = read_session(&file) else {
                continue;
            };
            if session.id != id {
                continue;
            }
            let is_fork = file.parent() == Some(fork_dir.as_path());
            let owned = if is_fork {
                None
            } else {
                file.with_extension("")
            };
            return Ok(Located {
                file,
                owned_directory: owned.filter(|dir| dir.is_dir()),
            });
        }
    }
    Err(format!("pi 里找不到会话 {id}"))
}

pub(crate) fn exists_at(root: &Path, id: &str) -> Result<bool, String> {
    Ok(locate(root, id).is_ok())
}

pub(crate) fn delete(id: &str) -> Result<(), String> {
    let root = default_root().ok_or("找不到用户主目录，无法定位 pi 会话目录")?;
    delete_at(&root, id)
}

pub(crate) fn delete_at(root: &Path, id: &str) -> Result<(), String> {
    let located = locate(root, id)?;
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|e| format!("无法解析 pi 会话目录 {}：{e}", root.display()))?;
    let mut targets = vec![located.file.clone()];
    if let Some(dir) = located.owned_directory {
        targets.push(dir);
    }
    // Every removal is proved to be inside the root first.
    for target in &targets {
        let canonical = std::fs::canonicalize(target)
            .map_err(|e| format!("无法解析待删除路径 {}：{e}", target.display()))?;
        if !canonical.starts_with(&canonical_root) {
            return Err(format!(
                "拒绝删除 pi 会话目录之外的路径：{}",
                canonical.display()
            ));
        }
    }
    for target in targets {
        let removed = if target.is_dir() {
            std::fs::remove_dir_all(&target)
        } else {
            std::fs::remove_file(&target)
        };
        removed.map_err(|e| format!("删除 {} 失败：{e}", target.display()))?;
    }
    Ok(())
}
```

- `read_session` 已按 id 解析首行；`locate` 复用它，所以"哪个文件属于这个 id"永远由数据本身证明，而不是由调用方指定路径。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /f/VibeCoding_workspace/Verta/src-tauri && cargo test -j 2 --lib agent_sessions`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd /f/VibeCoding_workspace/Verta
git add src-tauri/src/modules/agent_sessions/pi.rs
git commit -m "feat(agent-sessions): delete pi sessions by scan, inside the root only"
```

---

## Task 4: 命令层（逐条执行 + 删除后复核）

**Files:**
- Modify: `src-tauri/src/modules/agent_sessions/delete.rs`
- Modify: `src-tauri/src/modules/agent_sessions/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 写测试**

追加到 `delete.rs` 的 `tests`：

```rust
    #[test]
    fn one_bad_id_does_not_stop_the_others() {
        let targets = vec![
            SessionTarget { tool: "pi".into(), id: "../escape".into() },
            SessionTarget { tool: "pi".into(), id: "fine".into() },
        ];
        let outcomes = validate_all(&targets);
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].1, "fine");
    }

    #[test]
    fn an_unsupported_tool_is_rejected_per_item() {
        let targets = vec![SessionTarget { tool: "cursor".into(), id: "x".into() }];
        assert!(validate_all(&targets).is_empty());
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /f/VibeCoding_workspace/Verta/src-tauri && cargo test -j 2 --lib agent_sessions`

Expected: FAIL。

- [ ] **Step 3: 实现命令**

`delete.rs` 追加：

```rust
use crate::modules::agent_sessions::{opencode, pi};

/// Drops every target that fails the id/tool guard so the rest still run.
pub(crate) fn validate_all(targets: &[SessionTarget]) -> Vec<(String, String)> {
    targets
        .iter()
        .filter(|target| {
            validate_session_id(&target.id).is_ok()
                && (target.tool == opencode::TOOL || target.tool == pi::TOOL)
        })
        .map(|target| (target.tool.clone(), target.id.clone()))
        .collect()
}

#[tauri::command]
pub async fn agent_sessions_delete(targets: Vec<SessionTarget>) -> DeleteReport {
    crate::modules::fs::blocking(move || Ok(delete_targets(targets)))
        .await
        .unwrap_or_default()
}

fn delete_targets(targets: Vec<SessionTarget>) -> DeleteReport {
    let mut report = DeleteReport::default();
    for target in targets {
        let outcome = match validate_session_id(&target.id) {
            Err(reason) => DeleteOutcome {
                tool: target.tool,
                id: target.id,
                deleted: false,
                reason: Some(reason),
            },
            Ok(()) => {
                let result = match target.tool.as_str() {
                    opencode::TOOL => opencode::delete(&target.id),
                    pi::TOOL => pi::delete(&target.id),
                    other => Err(format!("不支持的会话工具：{other}")),
                };
                // The tool's own word is not enough: re-read the store.
                let deleted = result.is_ok() && gone(&target.tool, &target.id);
                DeleteOutcome {
                    tool: target.tool,
                    id: target.id,
                    deleted,
                    reason: if deleted {
                        None
                    } else {
                        Some(match result {
                            Err(reason) => reason,
                            Ok(()) => "删除后仍能读到该会话，可能未真正删除".to_string(),
                        })
                    },
                }
            }
        };
        if outcome.deleted {
            report.deleted += 1;
        }
        report.outcomes.push(outcome);
    }
    report
}

fn gone(tool: &str, id: &str) -> bool {
    match tool {
        opencode::TOOL => opencode::default_db_path()
            .map(|path| !opencode::exists_at(&path, id).unwrap_or(true))
            .unwrap_or(false),
        pi::TOOL => pi::default_root()
            .map(|root| !pi::exists_at(&root, id).unwrap_or(true))
            .unwrap_or(false),
        _ => false,
    }
}
```

`mod.rs` 加 `mod delete;` 与 `pub use delete::{agent_sessions_delete, DeleteReport, SessionTarget};`。

`lib.rs` 的 `generate_handler!` 里，紧跟 `agent_sessions::agent_sessions_list,` 之后加：

```rust
            agent_sessions::agent_sessions_delete,
```

- [ ] **Step 4: 编译 + 测试 + clippy**

Run:

```bash
cd /f/VibeCoding_workspace/Verta/src-tauri
cargo test -j 2 --lib agent_sessions
cargo clippy --all-targets --locked -j 2 -- -D warnings
```

Expected: 均通过（测试 30 个左右）。

- [ ] **Step 5: 提交**

```bash
cd /f/VibeCoding_workspace/Verta
git add src-tauri/src/modules/agent_sessions src-tauri/src/lib.rs
git commit -m "feat(agent-sessions): delete sessions over ipc and re-read to confirm"
```

---

## Task 4 实现修订（记录，2026-10-17）

实际实现与上面草稿的差异，都是踩到之后改的：

1. **命令定义在 `mod.rs`，不在 `delete.rs`**。`#[tauri::command]` 生成的 `__cmd__xxx` 宏**不能被 `pub use` 转出**，放在 `delete.rs` 会让 `generate_handler!` 在 `agent_sessions::__cmd__agent_sessions_delete` 上编译失败（实际踩到）。所以命令跟 `agent_sessions_list` 一样定义在模块根，逻辑仍留在 `delete.rs`。
2. **`validate_all` 没有实现**，也不需要：逐条删除的循环天然做到"一条失败不影响其余"，单独的预校验函数反而多一层。
3. **数据位置改成注入的 `Stores { opencode: Option<PathBuf>, pi: Option<PathBuf> }`**。原因是要让命令层在**临时 store** 上被测：`delete_targets` 直接调默认路径的话，任何一条测试都可能真删用户的会话。
4. **`outcome()` 抽成纯函数**，专门让"CLI 说成功但数据还在"这条规则可以被直接断言（`Ok(()) + gone=false` 必须报失败）。
5. **删掉适配器里的 `opencode::delete(id)` / `pi::delete(id)`**：命令层自己解析路径后它们没人用了，留着 clippy `-D warnings` 会因 dead code 失败。
6. **`SessionTarget` 提前加 `distro: Option<String>`**（带 `#[serde(default)]`）：spec §12.4 的 WSL 并存落地后，`{tool, id}` 无法区分两个仓库里同 id 的会话。现在收进来，是为了不让删除的 IPC 形状再变一次；有 `distro` 的目标明确返回"WSL 会话的删除尚未实现"，绝不静默当成 Windows 目标。

实际测试用例（`delete.rs` 的 `tests`，全部用临时 store）：

| 用例 | 断言 |
|---|---|
| `an_invalid_id_is_reported_and_nothing_is_deleted` | 报"非法 id"，且文件还在 |
| `an_unsupported_tool_is_reported` | 报"不支持" |
| `a_wsl_target_is_reported_as_not_implemented_yet` | 报 WSL 未实现，且文件还在 |
| `deletes_a_pi_session_and_counts_it` | `deleted == 1`、无 reason、目标没了、兄弟会话还在 |
| `one_failure_does_not_stop_the_other_targets` | 两条目标里第一条失败第二条成功 |
| `a_store_that_still_has_the_session_is_not_reported_as_a_success` | `Ok(()) + gone=false` 报"仍能读到" |
| `a_broken_opencode_store_is_reported_per_target` | 空 sqlite 库时报错而不是假装成功 |

实际结果：`cargo test -j 2 --lib agent_sessions` 46 passed / 0 failed；`cargo clippy --all-targets --locked -j 2 -- -D warnings` 无警告。

**仍然没被验证的东西**：opencode 删除的**成功路径**没有在真机跑过，因为那需要删一条真实会话。已覆盖的是 argv 与 cwd 的构造、未知 id 的失败语义（实测退出码 1）、以及"复核不过就不算成功"。第一次真实删除由用户在界面上执行。

---

## Task 5: 前端纯函数（选中集合与确认文案）

**Files:**
- Create: `src/modules/launcher/lib/selection.ts`
- Create: `src/modules/launcher/lib/selection.test.ts`
- Modify: `src/modules/launcher/lib/types.ts`
- Modify: `src/modules/launcher/lib/sessions.ts`

- [ ] **Step 1: 类型与 IPC**

`types.ts` 追加：

```ts
export type SessionTarget = {
  tool: AgentTool;
  id: string;
};

export type DeleteOutcome = {
  tool: AgentTool;
  id: string;
  deleted: boolean;
  reason: string | null;
};

export type DeleteReport = {
  deleted: number;
  outcomes: DeleteOutcome[];
};
```

`sessions.ts` 追加：

```ts
export function deleteAgentSessions(
  targets: SessionTarget[],
): Promise<DeleteReport> {
  return invoke<DeleteReport>("agent_sessions_delete", { targets });
}
```

- [ ] **Step 2: 写失败的测试**

`selection.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { deletionSummary, toggleSelection, updateSelection } from "./selection";
import type { AgentSession } from "./types";

const session = (
  id: string,
  tool: AgentSession["tool"],
  parentId: string | null = null,
): AgentSession => ({
  tool,
  id,
  title: id,
  cwd: "F:/x",
  updatedAtMs: 1,
  parentId,
});

describe("toggleSelection", () => {
  it("adds then removes an id", () => {
    const first = toggleSelection(new Set<string>(), "a");
    expect([...first]).toEqual(["a"]);
    expect([...toggleSelection(first, "a")]).toEqual([]);
  });

  it("never mutates the input", () => {
    const input = new Set(["a"]);
    toggleSelection(input, "b");
    expect([...input]).toEqual(["a"]);
  });
});

describe("updateSelection", () => {
  it("selects all visible ids", () => {
    expect([...updateSelection(new Set(), "all", ["a", "b"])].sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("adds visible ids to an existing selection", () => {
    expect([...updateSelection(new Set(["z"]), "all", ["a"])].sort()).toEqual([
      "a",
      "z",
    ]);
  });

  it("clears the visible ids only", () => {
    expect([...updateSelection(new Set(["a", "z"]), "none", ["a"])]).toEqual([
      "z",
    ]);
  });
});

describe("deletionSummary", () => {
  it("counts by tool and how many are subagent sessions", () => {
    const summary = deletionSummary([
      session("a", "opencode"),
      session("b", "opencode", "a"),
      session("c", "pi"),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.byTool).toEqual({ opencode: 2, pi: 1 });
    expect(summary.subagents).toBe(1);
    expect(summary.hasSubagents).toBe(true);
  });

  it("handles an empty selection", () => {
    const summary = deletionSummary([]);
    expect(summary.total).toBe(0);
    expect(summary.hasSubagents).toBe(false);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd /f/VibeCoding_workspace/Verta && pnpm exec vitest run src/modules/launcher/lib/selection.test.ts`

Expected: FAIL，无法解析 import。

- [ ] **Step 4: 实现**

`selection.ts`：

```ts
import type { AgentSession, AgentTool } from "./types";

export type SelectionMode = "all" | "none";

export function toggleSelection(
  selected: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/// Applies select-all / clear to the ids currently on screen, so a selection
/// made under a search term is never silently widened.
export function updateSelection(
  selected: ReadonlySet<string>,
  mode: SelectionMode,
  visibleIds: string[],
): Set<string> {
  const next = new Set(selected);
  for (const id of visibleIds) {
    if (mode === "all") next.add(id);
    else next.delete(id);
  }
  return next;
}

export type DeletionSummary = {
  total: number;
  byTool: Record<AgentTool, number>;
  subagents: number;
  hasSubagents: boolean;
};

export function deletionSummary(sessions: AgentSession[]): DeletionSummary {
  const byTool: Record<AgentTool, number> = { opencode: 0, pi: 0 };
  let subagents = 0;
  for (const session of sessions) {
    byTool[session.tool] += 1;
    if (session.parentId) subagents += 1;
  }
  return {
    total: sessions.length,
    byTool,
    subagents,
    hasSubagents: subagents > 0,
  };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd /f/VibeCoding_workspace/Verta && pnpm exec vitest run src/modules/launcher`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
cd /f/VibeCoding_workspace/Verta
git add src/modules/launcher/lib
git commit -m "feat(launcher): add selection helpers and the delete ipc call"
```

---

## Task 6: 管理态 UI（显示全部会话、多选、确认后删除）

**Files:**
- Modify: `src/modules/launcher/components/SessionList.tsx`
- Modify: `src/modules/launcher/components/LauncherPanel.tsx`

- [ ] **Step 1: 让行支持勾选与子代理标记**

`SessionList.tsx` 的 `Props` 加：

```ts
  selectable?: boolean;
  selected?: ReadonlySet<string>;
  onToggle?: (id: string) => void;
```

行渲染：`selectable` 时左侧渲染一个 `<input type="checkbox" checked readOnly />`（点击整行即切换，所以不改选中态用 readOnly 避免双源），并在 `session.parentId` 非空时追加一个"子代理"小标签。`selectable` 时点击调用 `onToggle(session.id)` 而不是 `onOpen`。

- [ ] **Step 2: 面板加管理态**

`LauncherPanel.tsx`：

- 新增 state：`managing`、`selected: Set<string>`、`pendingDelete: AgentSession[] | null`、`busy`。
- 顶部按钮：`管理` / `完成`（切换时清空选中）。
- 列表数据：管理态用 `allSessions`（不过滤子代理），非管理态用 `topLevel`。
- 底部：管理态渲染操作条为 `已选 N 条`、`全选`/`清空`、`删除`（N = 0 时禁用）。
- `删除` 打开确认框（`@/components/ui/alert-dialog`，与 `CloseDialogs.tsx` 用法一致）：

```tsx
<AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>删除会话？</AlertDialogTitle>
      <AlertDialogDescription>
        将永久删除 {summary.total} 条会话记录（opencode {summary.byTool.opencode} 条、pi {summary.byTool.pi} 条），数据从本机移除，无法撤销。
        {summary.hasSubagents
          ? ` 其中 ${summary.subagents} 条是子代理会话；删除 opencode 的父会话时，它的子会话会一并删除。`
          : ""}
        删除 pi 会话时会同时删除该会话的产物目录。
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>取消</AlertDialogCancel>
      <AlertDialogAction onClick={() => void confirmDelete()}>删除</AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

- `confirmDelete`：`deleteAgentSessions(targets)` → 把 `outcomes` 里 `deleted === false` 的原因拼成一段错误显示（放在面板已有的错误区），然后 `refresh()` 并清空选中。
- 若选中项里包含当前已打开的会话（`activeSessionId`），确认框追加一句提示：该会话正在终端里打开，删除后终端里的会话状态可能不一致。

- [ ] **Step 3: 检查**

Run:

```bash
cd /f/VibeCoding_workspace/Verta
pnpm exec biome check --write src/modules/launcher
pnpm check-types
pnpm lint
pnpm exec vitest run src/modules/launcher
```

Expected: 全绿。

- [ ] **Step 4: 提交**

```bash
cd /f/VibeCoding_workspace/Verta
git add src/modules/launcher/components
git commit -m "feat(launcher): manage and delete sessions from one view"
```

---

## Task 6 实现修订（记录，2026-10-17）

1. **勾选框是视觉 span，不是 Radix `Checkbox`**。`Checkbox` 渲染出来是一个 `<button role="checkbox">`，而会话行本身就是 `<button>`，嵌进去是非法 HTML，点击语义也会打架。行仍然是唯一的交互元素（键盘 Enter/Space 可用），勾选框只显示状态。
2. **行的 key 用 `sessionKey`（`tool:id`）**，不是裸 `id`：选中集合与 React key 都用同一个身份，避免两个工具撞 id。
3. **管理态列表用 `sessions`（全部，含子代理），非管理态用 `topLevel`**。搜索在两种态下都生效；`全选`/`清空` 只作用于**当前可见**（含搜索结果）的 key，不会偷偷扩大选择范围到看不见的行。
4. **`子代理` 标记**：`parentId !== null` 的行显示该标记，pi 的 fork 也算（它同样是子会话），所以确认框里写的是"子代理或分叉会话"。
5. **确认框的文案与数据在点击时一次性快照**（`PendingDelete { targets, summary, includesActive }`）：`targets` 给 IPC，`summary` 给文案里的条数与按工具分布，`includesActive` 决定是否追加"其中包含当前已在终端打开的会话"。这样弹窗打开后列表即使刷新，弹窗说的仍是用户当时选的东西。
6. **失败在刷新之后再报**：先 `refresh()` 让列表显示"剩下什么"，再把没删掉的逐条原因写进已有的错误区（一条一行），IPC 异常也走同一个错误区，不静默。

---

## Task 7: 验收（已完成，2026-10-17）

**Files:**
- 截图存本机 `docs/superpowers/shots/`（该目录不进版本库）：普通态、管理态、勾选 1 条；确认框这次没截到，见下
- Create: `scripts/dev/webview-eval.mjs` + `scripts/dev/probes/*.js`（DOM 级验收工具）

### 结果

| 检查项 | 结果 |
|---|---|
| 管理态显示全部会话（含子代理） | **通过**：24 行 = opencode 18（8 顶层 + 10 子代理）+ pi 6（4 本体 + 2 fork），子代理行带"子代理"标记（截图 `p1-09-manage.png`）；普通态则是 14 行（子代理与 fork 被隐藏） |
| 勾选与底部计数 | **通过**：勾 1 条 → `已选 1 条`，`删除` 由 disabled 变可用（截图 `p1-11-selected.png`） |
| 确认框文案 | **通过**：`删除会话？将从本机永久删除 1 条会话记录（opencode 1 条、pi 0 条），无法撤销。删除 opencode 的父会话会连带删除它的子会话。删除 pi 会话时会连同该会话的产物目录一起删除。其中 1 条是子代理或分叉会话。` |
| 取消不删任何东西 | **通过**：取消后确认框消失、选择保留、`session_v2` 仍 18 行、pi 仍 6 个文件 |
| 真删除成功路径 | **通过**（用户 2026-10-17 明确授权删一条子代理会话）：删 `ses_eda8cfdc5ffeN3XYbjTRWiSx92` 后 `session_v2` 18 → 17，逐条比对 id 列表**只少了这一条**，父会话与其剩余 4 个子会话都在，pi 6 个文件不动，WSL 侧 233 行不动 |
| 失败不谎报成功 | **通过**：第一次真删因 `capture::run` 缺少 piped stdio 而失败，界面显示 `有 1 条没能删除： opencode <id>：无法执行 opencode session delete：no stdout pipe`，且**什么都没删**（目标仍在库里）。修好后重跑成功 |

### 工具与踩坑（都记进需求台账 §4）

1. **像素点击不可靠**：截图显示的缩放会让人把坐标估偏约 50px，而且跨进程 `SetForegroundWindow` 会静默失败。可靠做法是 WebView2 远程调试口 + DOM：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 pnpm tauri dev`，然后 `node scripts/dev/webview-eval.mjs scripts/dev/probes/xxx.js`。
2. `scripts/dev/shot-window.ps1` 补了"窗口刚创建时只有 16x16"的等待（原来只处理最小化）。
3. `scripts/dev/click-window.ps1` 补了 ALT + `SetForegroundWindow` 重试与置前校验（跨进程置前会被拒且静默失败）。
4. **真删除必须由用户指定目标**（需求台账 C10）。本轮的唯一一次真实删除是用户明确授权的一条子代理会话。

### 验收标准对照

| 标准 | 结果 |
|---|---|
| `cargo test -j 2 --lib agent_sessions` 与 clippy `-D warnings` | 通过（47 个测试） |
| `pnpm lint` / `pnpm check-types` / launcher 测试 | 通过（launcher 28 个） |
| 管理界面列全部会话（含子代理）、多选可用 | 通过 |
| 前端无法指定路径（只传 `{tool, id}`）、非法 id 被拒 | 通过（`validate_session_id` 与用例） |
| pi 的删除被证明只发生在 root 之内 | 通过（含 `..` / 绝对路径 / 分隔符三类反例） |
| 删除后复核，CLI 报成功但数据仍在时显示失败 | 通过（`outcome()` 用例 + 真机那次失败） |
| 确认框逐条说明连带影响；未确认不删任何东西 | 通过 |
| 我自己没有删任何真实会话 | 通过：唯一一次真实删除由用户明确授权（见上） |

---

## 验收标准

1. `cargo test -j 2 --lib agent_sessions` 与 `cargo clippy --all-targets --locked -j 2 -- -D warnings` 通过
2. `pnpm lint` exit 0、`pnpm check-types` 通过、`pnpm exec vitest run --maxWorkers=2` 全绿
3. 管理界面能列出全部会话（含子代理），多选可用
4. 前端无法指定路径：命令签名只有 `{tool, id}`；非法 id 被拒且有测试
5. pi 的删除被证明只发生在 pi root 之内（含 `..` / 绝对路径 / 分隔符三类反例的测试）
6. 删除后复核：CLI 报成功但数据仍在时，界面显示失败而不是成功
7. 确认框逐条说明连带影响；未确认不会删除任何东西
8. 我自己没有删除任何真实会话，验收证据里包含"取消后数据未变"的核对

---

## 已知取舍与后续

1. **opencode 只传 id、不传 cwd**：CLI 在会话自己的目录里执行（目录由 Rust 从库里查）。若将来 CLI 改成全局查找，这个 cwd 也无害。
2. **opencode 的删除是逐条启动 CLI**（多选 20 条就是 20 次进程）。每次有 30 秒超时，慢但可控；必要时再换成单次批量。
3. **pi 的删除会连带删掉该会话的产物目录**（里面含子代理产物与 forks），这一点已在确认框里写明。
4. **不做回收站**：用户明确要求删数据而不是隐藏。若以后想要还原窗口，把 pi 的文件改成移动到应用数据目录下的 `trash/` 即可，opencode 侧则要依赖它的 `session export`。
5. **openclaw / claude / codex 等其它 agent** 目前没有适配器，所以管理界面里也不会出现；Coffee-CLI 的图标集合（`src-ui/src/icons-inline/` 下 20+ 个）可以作为将来加适配器时的**参考清单**，但按 spec §9 不允许复制它的资源文件，图标要用各项目自己的官方素材（opencode 的已从它的发行版里提取）。