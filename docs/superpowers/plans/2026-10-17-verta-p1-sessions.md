# Verta P1（会话列表）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 左栏新增「会话」面板，列出本机 opencode 与 pi 的历史 agent 会话；点一条会话，就在它自己记录的目录里开一个终端标签并执行该工具的 resume 命令。

**Architecture:** Rust 侧新增 `modules/agent_sessions`，按 tool 注册适配器：opencode 只读查询 `session_v2`，pi 扫描 `~/.pi/agent/sessions` 的 `.jsonl`。两者都把结果归一成同一个 `AgentSession`，并各自返回 `warnings`（不静默失败）。前端新增 `modules/launcher`，其中命令拼装、相对时间、父子折叠都是纯函数（可单测），网络/进程边界只有 `sessions.ts` 一处。点会话时把 `(tool, id, cwd)` 作为不可拆单元交给 App.tsx，App 用 terax 既有的 `newAgentTab` + `whenSessionReady` + `writeToSession` 落地。

**Tech Stack:** Tauri 2 / Rust（新增 rusqlite bundled）/ React 19 / TypeScript / zustand / vitest / Tailwind v4

---

## 0. 对 spec 的修正（已在真机核实，不是推测）

写代码前必须先看这一节。spec §4 的数据契约有 4 处与本机实况不符，照 spec 实现会得到「陈旧列表」和「空列表」两类静默故障（正撞 spec §5.5）。

| spec 原文 | 真机实测 | 本计划的处理 |
|---|---|---|
| opencode 读 `session` 表 | `session_v2` 才是活表：17 行，含当天 21:08 的会话。`session` 是迁移前旧表：10 行，最后写入 10-14（spec 的示例行正是从这张旧表抄的） | 优先 `session_v2`，表不存在时回退 `session`；两表核心列同名，SQL 可共用 |
| pi 会话是 `<编码cwd>/<ISO>_<uuid>/session.jsonl` | 真正的会话是 `<编码cwd>/<ISO>_<uuid>.jsonl`（顶层文件）。同名的那个目录里装的是子代理产物（`<uuid>/run-0`）与 `forks/*.jsonl`，**不是会话本体** | 只扫 `*/*.jsonl` 与 `*/forks/*.jsonl` |
| pi 的 cwd 靠解码目录名 | 会话首行自带 cwd：`{"type":"session","version":3,"id":"01a147ad-…","timestamp":"…","cwd":"F:\\VibeCoding_workspace\\WorkBuddy"}` | 用首行的 cwd；目录名解码只作兜底，且它本身有损（见 Task 4） |
| pi 标题取自 `missions/index/*.json` 的 `title` | 实测值为 `[prompt redacted]`，且按 missionId 组织，还有 `status: failed`，不是会话标题 | 标题取 `session_info.name`，其次首条 user 消息文本，最后回退目录名 |

另有两条与 spec 无关但影响本计划的实测结论：

- **本机无日期库**（Cargo.toml 没有 chrono/time），而 pi 首行的时间戳是 ISO 字符串。为不引入新依赖，pi 的 `updatedAt` 用**文件 mtime**（`std::fs::metadata(...).modified()`）。opencode 的 `time_updated` 本来就是 epoch 毫秒，直接用。
- **resume 命令的真实参数**（`--help` 原文核实）：`opencode --session <id> [<directory>]`，帮助里写着 `Session ID to continue, or to create if it does not exist`（**传错 id 会静默新建会话**）；`pi --session <path|id>` 支持 partial UUID。

---

## 0.5 实现时对计划的修订（实际执行后回填）

计划是开工前写的，落地时有 5 处必须改正，后续按本节为准：

1. **`useSidebarPanel` 的白名单（计划漏项，必须补）**：`src/modules/sidebar/useSidebarPanel.ts` 的 `readSidebarView()` 里硬编码了 `if (stored === "explorer" || stored === "source-control") return stored;`。不加 `"launcher"` 的话，视图切到会话面板后**重启无法恢复**（会悄悄回落成 explorer）。所以 Task 10 除了 `types.ts`，还必须改这个函数。
2. **临时目录用既有 `tempfile`**：`tempfile = "3"` 已是 dev-dependency，测试用 `tempfile::tempdir()`，不新增 `tempdir 0.3`。
3. **注释语言按上游**：本仓库 Rust 与 TS 的注释是**英文**（TERAX.md 的 `Comments: default to none... 1-2 lines on why` 也是英文写的），因此新代码的注释与测试名用英文；只有**面向用户的文案**（错误信息、面板标签、占位符、空态）用中文，符合"界面中文"的偏好。已知后果：继承自上游的界面文案仍是英文，需要单独一轮翻译，不属 P1 范围。
4. **面板必须走 `Lazy` 包装**：仓库有 `src/app/eager-budget.test.ts` 与 `src/app/dist-budget.test.ts` 两个产物体积预算测试（`HEAVY` 列表锁定 AI SDK / CodeMirror / 图标集等不得进入启动图）。既有面板的统一做法是 `XxxPanelLazy.tsx` + barrel 导出 Lazy 版（见 `src/modules/source-control/index.ts`），`LauncherPanel` 照此办理。
5. **`resumeCommand` 从 barrel 导出**：App.tsx 需要它，跨模块引用走 `@/modules/launcher` 而不是深路径（TERAX.md：前端 import 一律 `@/...`，不跨模块用相对路径）。

另外一处实现加强：opencode 的表选择测试补了「同一库里同时存在 `session` 与 `session_v2` 时选 `session_v2`」与「库存在但没有任何已知表时报错」两个用例。

6. **pi 的前缀窗口从 512 行 / 256 KiB 提到 8 MiB / 100,000 行（实测驱动的修正）**：GUI 验收时发现 4 个 pi 会话里有 2 个标题显示成原始 prompt，而它们其实都有 `session_info.name`。实测字节偏移后确认原因是窗口太小（名字最晚出现在 3.98 MiB 处），详见 §1.2 与执行记录。这条属于「照计划实现会得到可见错误结果」的那类问题，靠验收对照期望值才发现。

### 1.1 opencode

- 库：`~/.local/share/opencode/opencode.db`（本机 5 621 583 872 B，另有 `-wal` / `-shm`）。
- 连接：只读。**WAL 库的只读打开依赖 `-shm` 可写**，因此打不开时要报明确错误，不能返回空列表。
- SQL（两个表核心列同名）：

```sql
SELECT id, parent_id, title, directory, time_updated
FROM session_v2
ORDER BY time_updated DESC
LIMIT 200
```

- `parent_id` 非空 = 子会话（子代理）。列表默认折叠，不丢弃。
- `directory` 形如 `F:/VibeCoding_workspace/GitShow`、`C:/Users/费马大定理/Desktop`，**原样保留**（交给终端时由前端加引号）。
- 恢复：cwd = 该会话的 `directory`，命令 = `opencode --session <id> <cwd>`。

### 1.2 pi

- 根：`~/.pi/agent/sessions/<编码后的cwd>/`。本机 5 个编码目录，其中只有 3 个含真实会话（共 4 个文件）。
- 会话文件两种位置，都算会话：`<root>/<编码cwd>/<ISO>_<uuid>.jsonl`（普通会话）、`<root>/<编码cwd>/forks/<ISO>_<uuid>.jsonl`（叉，首行带 `parentSession`）。
- 首行结构（version 3）：

```json
{"type":"session","version":3,"id":"01a147ad-023f-71ff-b404-bb337dea4b63","timestamp":"2026-10-17T02:24:43.071Z","cwd":"F:\\VibeCoding_workspace\\WorkBuddy"}
```

- 标题来源（按优先级）：`{"type":"session_info",...,"name":"daily talk"}`，否则首条 user 消息：

```json
{"type":"message","id":"…","parentId":"…","timestamp":"…","message":{"role":"user","content":[{"type":"text","text":"查看pi是否有两个压缩插件一个自带一个第三方"}]}}
```

- 读取范围：**实测推翻了原计划的"512 行 / 256 KiB"**。名字（`session_info`）不是写在文件开头，而是用户命名的那一刻，本机实测最晚的一条在 **4,175,445 字节（3.98 MiB）** 处（一个 4.18 MB 的会话）；首条 user 消息则总在 77 KiB 内。因此窗口改为 **8 MiB 或 100,000 行（先到者为准）**，并在**命中第一个名字时立即停止扫描**（大多数会话只读几十到几百 KB，不会为每个文件读满 8 MiB）。代价：一个被改名多次的会话显示它较早的那个名字（本机 ModelHarbor 那条会显示 `ModelHarber2` 而非后来的 `ModelHarber`），已用 `the_prefix_window_is_bounded_by_bytes_and_lines` 与 `a_name_far_past_the_first_message_still_wins` 两个用例把这个取舍钉住。
- 恢复：cwd = 会话首行的 `cwd`，命令 = `pi --session <uuid>`（cwd 必须成对传递，否则 pi 会在别的项目目录里找会话）。

---

## 2. 文件结构

**Rust（新增模块，放在 `src-tauri/src/modules/agent_sessions/`）**

| 文件 | 职责 |
|---|---|
| `mod.rs` | 唯一对外命令 `agent_sessions_list`、tool 派发、payload 类型 |
| `types.rs` | `AgentSession`、`AgentSessionsPayload`（serde camelCase） |
| `opencode.rs` | 表选择、只读连接、SQL、行映射（纯函数） |
| `pi.rs` | 目录扫描、首行解析、标题提取（纯函数）、目录名解码（纯函数，兜底） |

**Rust（改动既有文件，共 3 处）**

| 文件 | 改动 |
|---|---|
| `src-tauri/src/modules/mod.rs` | 加一行 `pub mod agent_sessions;` |
| `src-tauri/src/lib.rs:273` | `generate_handler!` 里加 `agent_sessions::agent_sessions_list,` |
| `src-tauri/Cargo.toml:38` | 加 `rusqlite`（`bundled`） |

**前端（新增 `src/modules/launcher/`）**

| 文件 | 职责 |
|---|---|
| `index.ts` | barrel，只导出 `LauncherPanel` 与类型 |
| `lib/types.ts` | `AgentTool`、`AgentSession`、`AgentSessionsPayload` |
| `lib/sessions.ts` | `invoke("agent_sessions_list")` 唯一出口 |
| `lib/resumeCommand.ts` | 纯函数：`(tool, id, cwd) -> string` |
| `lib/relativeTime.ts` | 纯函数：`(nowMs, updatedAtMs) -> string` |
| `lib/sessionTree.ts` | 纯函数：把扁平行折叠成 `{ parent, children }[]` |
| `components/LauncherPanel.tsx` | 面板外壳：工具页签 + 搜索框 + 刷新 + 错误/警告区 |
| `components/SessionList.tsx` | 会话行渲染与点击 |

**前端（改动既有文件，共 3 处）**

| 文件 | 改动 |
|---|---|
| `src/modules/sidebar/types.ts:1` | `SidebarViewId` 加 `"launcher"` |
| `src/modules/sidebar/SidebarRail.tsx:24` | `items` 里加一项 |
| `src/app/App.tsx:1480` | 二元三目改三路，并实现 `onOpenSession` |

---

## Task 1: 加 rusqlite 依赖并保持构建通过

**Files:**
- Modify: `src-tauri/Cargo.toml:38-76`

- [x] **Step 1: 用 cargo add 解析版本（不手写版本号，避免猜错）**

Run:

```bash
cd /f/VibeCoding_workspace/Verta/src-tauri
cargo add rusqlite --features bundled -j 2
```

Expected: `Cargo.toml` 的 `[dependencies]` 出现 `rusqlite = { version = "…", features = ["bundled"] }`，`Cargo.lock` 更新。

- `bundled` 是硬要求（spec §3.1）：本机没有系统 sqlite，且要保证 Windows 上一致。
- 需要联网。会新编译 `libsqlite3-sys`（含 C 代码），内存敏感，**必须 `-j 2`**。

- [x] **Step 2: 确认仍能编译**

Run:

```bash
cd /f/VibeCoding_workspace/Verta/src-tauri
cargo build -j 2
```

Expected: `Finished`。若 `E0463`，`cargo clean -p <crate>` 后重跑。

- [x] **Step 3: 提交**

```bash
cd /f/VibeCoding_workspace/Verta
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "build: add rusqlite with the bundled sqlite for agent session reads"
```

---

## Task 2: Rust 类型 + opencode 行映射（纯函数）

**Files:**
- Create: `src-tauri/src/modules/agent_sessions/types.rs`
- Create: `src-tauri/src/modules/agent_sessions/opencode.rs`
- Create: `src-tauri/src/modules/agent_sessions/mod.rs`
- Modify: `src-tauri/src/modules/mod.rs`

- [x] **Step 1: 写类型**

`types.rs`：

```rust
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub tool: String,
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub updated_at_ms: i64,
    pub parent_id: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionsPayload {
    pub sessions: Vec<AgentSession>,
    pub warnings: Vec<String>,
}
```

- [x] **Step 2: 写失败的映射测试**

`opencode.rs` 里先只放测试：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_a_row_with_title() {
        let session = map_row(
            "ses_1",
            None,
            Some("GitShow Go".to_string()),
            "F:/VibeCoding_workspace/GitShow",
            1_791_820_691_308,
        );
        assert_eq!(session.id, "ses_1");
        assert_eq!(session.title, "GitShow Go");
        assert_eq!(session.cwd, "F:/VibeCoding_workspace/GitShow");
        assert_eq!(session.parent_id, None);
        assert_eq!(session.tool, "opencode");
    }

    #[test]
    fn blank_title_falls_back_to_directory_name() {
        let session = map_row("ses_2", None, Some("   ".to_string()), "F:/x/bear_bill", 1);
        assert_eq!(session.title, "bear_bill");
    }

    #[test]
    fn null_title_and_trailing_slash_fall_back_to_directory_name() {
        let session = map_row("ses_3", None, None, "F:/x/PasteLabel/", 1);
        assert_eq!(session.title, "PasteLabel");
    }

    #[test]
    fn keeps_parent_id_for_subagent_sessions() {
        let session = map_row("ses_4", Some("ses_1".to_string()), None, "F:/x", 1);
        assert_eq!(session.parent_id.as_deref(), Some("ses_1"));
    }
}
```

- [x] **Step 3: 跑测试确认失败**

Run:

```bash
cd /f/VibeCoding_workspace/Verta/src-tauri
cargo test -j 2 --locked agent_sessions
```

Expected: FAIL，`cannot find function map_row`。

- [x] **Step 4: 实现映射（最小实现）**

`opencode.rs` 顶部：

```rust
use super::types::AgentSession;

pub(crate) const TOOL: &str = "opencode";

pub(crate) fn map_row(
    id: &str,
    parent_id: Option<String>,
    title: Option<String>,
    directory: &str,
    time_updated: i64,
) -> AgentSession {
    let title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| directory_name(directory));
    AgentSession {
        tool: TOOL.to_string(),
        id: id.to_string(),
        title,
        cwd: directory.to_string(),
        updated_at_ms: time_updated,
        parent_id,
    }
}

/// 会话标题缺失时用目录名兜底，同时兼容结尾带分隔符的写法。
pub(crate) fn directory_name(directory: &str) -> String {
    let trimmed = directory.trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(trimmed)
        .to_string()
}
```

`mod.rs`：

```rust
pub mod types;
mod opencode;
```

`src-tauri/src/modules/mod.rs` 加一行（保持字母序，插在 `pub mod agent;` 之后）：

```rust
pub mod agent_sessions;
```

- [x] **Step 5: 跑测试确认通过**

Run:

```bash
cd /f/VibeCoding_workspace/Verta/src-tauri
cargo test -j 2 --locked agent_sessions
```

Expected: PASS，4 个测试全绿。

- [x] **Step 6: 提交**

```bash
cd /f/VibeCoding_workspace/Verta
git add src-tauri/src/modules/agent_sessions src-tauri/src/modules/mod.rs
git commit -m "feat(agent-sessions): add session types and opencode row mapping"
```

---

## Task 3: opencode 适配器（只读 sqlite，表选择 + 集成测试）

**Files:**
- Modify: `src-tauri/src/modules/agent_sessions/opencode.rs`

- [x] **Step 1: 写表选择与连接测试（用临时 sqlite，绝不碰真实库）**

在 `opencode.rs` 的 `tests` 模块里追加：

```rust
    fn temp_db(schema_for: &str) -> (tempdir::TempDir, std::path::PathBuf) {
        let dir = tempdir::TempDir::new("verta-opencode-test").unwrap();
        let path = dir.path().join("opencode.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE {schema_for} (
                id TEXT PRIMARY KEY,
                parent_id TEXT,
                title TEXT,
                directory TEXT NOT NULL,
                time_updated INTEGER NOT NULL
            );"
        ))
        .unwrap();
        (dir, path)
    }

    fn insert(path: &std::path::Path, table: &str, id: &str, parent: Option<&str>, title: Option<&str>, dir: &str, ts: i64) {
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute(
            &format!("INSERT INTO {table} (id, parent_id, title, directory, time_updated) VALUES (?1, ?2, ?3, ?4, ?5)"),
            rusqlite::params![id, parent, title, dir, ts],
        )
        .unwrap();
    }

    #[test]
    fn prefers_session_v2_when_present() {
        let (_dir, path) = temp_db("session_v2");
        insert(&path, "session_v2", "ses_new", None, Some("新会话"), "F:/new", 20);
        assert_eq!(session_table(&path).unwrap(), "session_v2");
    }

    #[test]
    fn falls_back_to_session_table() {
        let (_dir, path) = temp_db("session");
        insert(&path, "session", "ses_old", None, Some("旧会话"), "F:/old", 10);
        assert_eq!(session_table(&path).unwrap(), "session");
        let payload = list_at(&path).unwrap();
        assert_eq!(payload.sessions.len(), 1);
        assert_eq!(payload.sessions[0].id, "ses_old");
    }

    #[test]
    fn orders_by_time_updated_desc_and_keeps_children() {
        let (_dir, path) = temp_db("session_v2");
        insert(&path, "session_v2", "ses_a", None, Some("A"), "F:/a", 10);
        insert(&path, "session_v2", "ses_b", Some("ses_a"), Some("B"), "F:/b", 30);
        let payload = list_at(&path).unwrap();
        assert_eq!(
            payload.sessions.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["ses_b", "ses_a"]
        );
        assert_eq!(payload.sessions[0].parent_id.as_deref(), Some("ses_a"));
    }

    #[test]
    fn missing_database_is_a_clear_error_not_an_empty_list() {
        let dir = tempdir::TempDir::new("verta-opencode-missing").unwrap();
        let error = list_at(&dir.path().join("nope.db")).unwrap_err();
        assert!(error.contains("opencode"), "unexpected error: {error}");
    }
```

- [x] **Step 2: 跑测试确认失败**

Run:

```bash
cd /f/VibeCoding_workspace/Verta/src-tauri
cargo test -j 2 --locked agent_sessions
```

Expected: FAIL，`cannot find function session_table` / `list_at` / `tempdir`。

- [x] **Step 3: 实现适配器**

在 `opencode.rs` 加（`tests` 模块之外）：

```rust
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use super::types::{AgentSession, AgentSessionsPayload};

pub(crate) const DB_ORDER: &[&str] = &["session_v2", "session"];
const MAX_ROWS: usize = 200;
const BUSY_TIMEOUT: Duration = Duration::from_secs(3);

/// opencode 在 Windows 上把数据放在 `~/.local/share`，不是 `%LOCALAPPDATA%`。
pub(crate) fn default_db_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".local/share/opencode/opencode.db"))
}

pub(crate) fn list() -> Result<AgentSessionsPayload, String> {
    let path = default_db_path().ok_or("找不到用户主目录，无法定位 opencode 数据库")?;
    list_at(&path)
}

pub(crate) fn list_at(path: &Path) -> Result<AgentSessionsPayload, String> {
    if !path.is_file() {
        return Err(format!(
            "找不到 opencode 数据库：{}。请确认 opencode 已安装并至少运行过一次。",
            path.display()
        ));
    }
    let table = session_table(path)?;
    let conn = open_read_only(path)?;
    let sql = format!(
        "SELECT id, parent_id, title, directory, time_updated
         FROM {table}
         ORDER BY time_updated DESC
         LIMIT {MAX_ROWS}"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("读取 opencode 会话失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| format!("读取 opencode 会话失败：{e}"))?;

    let mut sessions: Vec<AgentSession> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    for row in rows {
        match row {
            Ok((id, parent_id, title, directory, time_updated)) => sessions.push(map_row(
                &id,
                parent_id,
                title,
                &directory,
                time_updated,
            )),
            Err(error) => warnings.push(format!("跳过一行无法解析的 opencode 会话：{error}")),
        }
    }
    Ok(AgentSessionsPayload { sessions, warnings })
}

/// 2.0.x 写到 `session_v2`，旧库只有 `session`；两表核心列同名。
pub(crate) fn session_table(path: &Path) -> Result<String, String> {
    let conn = open_read_only(path)?;
    for candidate in DB_ORDER {
        let found: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [candidate],
                |row| row.get(0),
            )
            .map_err(|e| format!("读取 opencode 数据库结构失败：{e}"))?;
        if found > 0 {
            return Ok((*candidate).to_string());
        }
    }
    Err("opencode 数据库里既没有 session_v2 也没有 session 表".to_string())
}

/// WAL 库的只读打开要求 `-shm` 可写；打不开时给出可执行的提示而不是空列表。
fn open_read_only(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| {
        format!(
            "无法只读打开 opencode 数据库 {}：{e}。若 opencode 正在写入，请稍后重试。",
            path.display()
        )
    })?;
    conn.busy_timeout(BUSY_TIMEOUT)
        .map_err(|e| format!("设置 opencode 数据库超时失败：{e}"))?;
    Ok(conn)
}
```

`Cargo.toml` 的 `[dev-dependencies]` **不需要新增任何东西**：`tempfile = "3"` 已经是既有 dev-dependency（`src-tauri/Cargo.toml:81`），测试里用 `tempfile::tempdir()` 即可。不要引入已停止维护的 `tempdir 0.3`。

- [x] **Step 4: 跑测试确认通过**

Run:

```bash
cd /f/VibeCoding_workspace/Verta/src-tauri
cargo test -j 2 agent_sessions
```

Expected: PASS（Task 2 的 4 个 + Task 3 的 4 个）。

注意这里**故意不带 `--locked`**：新增 dev 依赖会改 `Cargo.lock`，先让 cargo 更新它。更新后在 Step 5 一并提交。

- [x] **Step 5: 提交**

```bash
cd /f/VibeCoding_workspace/Verta
git add src-tauri/src/modules/agent_sessions/opencode.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(agent-sessions): read opencode sessions from a read-only sqlite connection"
```

---

## Task 4: pi 适配器（扫目录 + 标题提取纯函数）

**Files:**
- Create: `src-tauri/src/modules/agent_sessions/pi.rs`
- Modify: `src-tauri/src/modules/agent_sessions/mod.rs`

- [x] **Step 1: 写纯函数的失败测试**

`pi.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_session_info_name() {
        let prefix = concat!(
            r#"{"type":"session","version":3,"id":"01a147ad","timestamp":"2026-10-17T02:24:43.071Z","cwd":"F:\\VibeCoding_workspace\\WorkBuddy"}"#,
            "\n",
            r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"随便问问"}]}}"#,
            "\n",
            r#"{"type":"session_info","id":"d7c7f713","timestamp":"2026-10-17T02:25:47.637Z","name":"daily talk"}"#,
            "\n",
        );
        assert_eq!(title_from_prefix(prefix).as_deref(), Some("daily talk"));
    }

    #[test]
    fn falls_back_to_first_user_message() {
        let prefix = concat!(
            r#"{"type":"session","version":3,"id":"01a0fa77","cwd":"F:\\x"}"#,
            "\n",
            r#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"我是助手"}]}}"#,
            "\n",
            r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"查看pi是否有两个压缩插件一个自带一个第三方"}]}}"#,
            "\n",
        );
        assert_eq!(
            title_from_prefix(prefix).as_deref(),
            Some("查看pi是否有两个压缩插件一个自带一个第三方")
        );
    }

    #[test]
    fn accepts_string_content_and_collapses_whitespace() {
        let prefix = "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"  多行\n  内容  \"}}";
        assert_eq!(title_from_prefix(prefix).as_deref(), Some("多行 内容"));
    }

    #[test]
    fn ignores_broken_lines_and_returns_none_without_any_signal() {
        assert_eq!(title_from_prefix("{not json}\n{\"type\":\"model_change\"}").as_deref(), None);
    }

    #[test]
    fn decodes_the_two_real_directory_shapes() {
        assert_eq!(
            decode_cwd_dirname("--F--VibeCoding_workspace-ModelHarbor--").as_deref(),
            Some("F:\\VibeCoding_workspace\\ModelHarbor")
        );
        assert_eq!(
            decode_cwd_dirname("--C--Users-费马大定理--").as_deref(),
            Some("C:\\Users\\费马大定理")
        );
        assert_eq!(decode_cwd_dirname("garbage"), None);
    }
}
```

- [x] **Step 2: 跑测试确认失败**

Run:

```bash
cd /f/VibeCoding_workspace/Verta/src-tauri
cargo test -j 2 agent_sessions
```

Expected: FAIL，`cannot find function title_from_prefix` / `decode_cwd_dirname`。

- [x] **Step 3: 实现纯函数**

`pi.rs` 顶部：

```rust
use std::path::PathBuf;

use serde_json::Value;

use super::types::{AgentSession, AgentSessionsPayload};

pub(crate) const TOOL: &str = "pi";
const MAX_TITLE_CHARS: usize = 80;

pub(crate) fn default_root() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".pi/agent/sessions"))
}

/// 会话标题：优先 `session_info.name`，其次首条 user 消息。都取不到时回退目录名。
pub(crate) fn title_from_prefix(prefix: &str) -> Option<String> {
    let mut first_user: Option<String> = None;
    for line in prefix.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("session_info") => {
                if let Some(name) = value.get("name").and_then(Value::as_str) {
                    let name = collapse_whitespace(name);
                    if !name.is_empty() {
                        return Some(name);
                    }
                }
            }
            Some("message") if first_user.is_none() => {
                let message = value.get("message");
                if message.and_then(|m| m.get("role")).and_then(Value::as_str) == Some("user") {
                    first_user = message.and_then(|m| m.get("content")).and_then(text_of_content);
                }
            }
            _ => {}
        }
    }
    first_user
}

fn text_of_content(content: &Value) -> Option<String> {
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => return None,
    };
    let text = collapse_whitespace(&text);
    if text.is_empty() {
        return None;
    }
    Some(truncate_chars(&text, MAX_TITLE_CHARS))
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

/// 首行没有 cwd 时的兜底。编码把分隔符压成 `-`，因此含 `-` 的真实目录名会被还原错，
/// 只在首行不可读时使用。
pub(crate) fn decode_cwd_dirname(name: &str) -> Option<String> {
    let inner = name.strip_prefix("--")?.strip_suffix("--")?;
    let (drive, rest) = inner.split_once("--")?;
    if drive.is_empty() {
        return None;
    }
    Some(format!("{}:\\{}", drive, rest.replace('-', "\\")))
}
```

`mod.rs` 加 `mod pi;`。

- [x] **Step 4: 跑测试确认通过**

Run:

```bash
cd /f/VibeCoding_workspace/Verta/src-tauri
cargo test -j 2 agent_sessions
```

Expected: PASS（5 个新测试全绿）。

- [x] **Step 5: 实现扫描与列表（集成测试用临时目录）**

追加到 `pi.rs`（`tests` 之外）：

```rust
const MAX_PREFIX_LINES: usize = 512;
const MAX_PREFIX_BYTES: usize = 256 * 1024;

pub(crate) fn list() -> Result<AgentSessionsPayload, String> {
    let root = default_root().ok_or("找不到用户主目录，无法定位 pi 会话目录")?;
    list_at(&root)
}

pub(crate) fn list_at(root: &std::path::Path) -> Result<AgentSessionsPayload, String> {
    if !root.is_dir() {
        return Err(format!(
            "找不到 pi 会话目录：{}。请确认 pi 已安装并至少运行过一次。",
            root.display()
        ));
    }
    let mut sessions: Vec<AgentSession> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let project_dirs = read_dir_paths(root)?;
    for project_dir in project_dirs {
        if !project_dir.is_dir() {
            continue;
        }
        let mut files = read_dir_paths(&project_dir).unwrap_or_default();
        if let Ok(forks) = read_dir_paths(&project_dir.join("forks")) {
            files.extend(forks);
        }
        for file in files {
            if file.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            match read_session(&file) {
                Ok(Some(session)) => sessions.push(session),
                Ok(None) => {}
                Err(error) => warnings.push(error),
            }
        }
    }
    sessions.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
    Ok(AgentSessionsPayload { sessions, warnings })
}

fn read_dir_paths(dir: &std::path::Path) -> Result<Vec<PathBuf>, String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("无法读取目录 {}：{e}", dir.display()))?;
    Ok(entries.filter_map(|entry| entry.ok()).map(|entry| entry.path()).collect())
}

/// 返回 `Ok(None)` 表示这个文件不是会话（例如 `subagent-artifacts` 里的 jsonl）。
fn read_session(file: &std::path::Path) -> Result<Option<AgentSession>, String> {
    let prefix = read_prefix(file)?;
    let mut lines = prefix.lines();
    let Some(first) = lines.next() else {
        return Ok(None);
    };
    let Ok(header) = serde_json::from_str::<Value>(first) else {
        return Ok(None);
    };
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return Ok(None);
    }
    let Some(id) = header.get("id").and_then(Value::as_str) else {
        return Ok(None);
    };
    let cwd = header
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            file.parent()
                .and_then(|dir| dir.file_name())
                .and_then(|name| name.to_str())
                .and_then(decode_cwd_dirname)
        });
    let Some(cwd) = cwd else {
        return Err(format!("会话 {} 既没有 cwd 也无法从目录名还原", file.display()));
    };
    let title = title_from_prefix(&prefix).unwrap_or_else(|| {
        file.file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or(id)
            .to_string()
    });
    let updated_at_ms = modified_ms(file).unwrap_or(0);
    Ok(Some(AgentSession {
        tool: TOOL.to_string(),
        id: id.to_string(),
        title,
        cwd,
        updated_at_ms,
        parent_id: header
            .get("parentSession")
            .and_then(Value::as_str)
            .map(str::to_string),
    }))
}

fn read_prefix(file: &std::path::Path) -> Result<String, String> {
    use std::io::{BufRead, BufReader, Read};

    let handle = std::fs::File::open(file)
        .map_err(|e| format!("无法打开会话文件 {}：{e}", file.display()))?;
    let mut reader = BufReader::new(handle.take(MAX_PREFIX_BYTES as u64));
    let mut prefix = String::new();
    let mut line = String::new();
    let mut lines = 0;
    while lines < MAX_PREFIX_LINES {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                prefix.push_str(&line);
                lines += 1;
            }
            // 前缀被字节上限截断在多字节字符中间时，保留已读到的部分。
            Err(error) if error.kind() == std::io::ErrorKind::InvalidData => break,
            Err(error) => return Err(format!("读取会话文件 {} 失败：{error}", file.display())),
        }
    }
    Ok(prefix)
}

fn modified_ms(file: &std::path::Path) -> Option<i64> {
    let modified = std::fs::metadata(file).ok()?.modified().ok()?;
    let duration = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(duration.as_millis() as i64)
}
```

再加 3 个集成测试（同 `tests` 模块）：

```rust
    fn write_session(dir: &std::path::Path, name: &str, body: &str) -> std::path::PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn scans_top_level_and_forks_but_skips_non_sessions() {
        let root = tempdir::TempDir::new("verta-pi-test").unwrap();
        let project = root.path().join("--F--VibeCoding_workspace-ModelHarbor--");
        write_session(
            &project,
            "2026-10-17T02-24-43-071Z_01a147ad.jsonl",
            concat!(
                r#"{"type":"session","version":3,"id":"01a147ad","cwd":"F:\\VibeCoding_workspace\\ModelHarbor"}"#,
                "\n",
                r#"{"type":"session_info","name":"daily talk"}"#,
                "\n",
            ),
        );
        write_session(
            &project.join("forks"),
            "2026-10-17T03-00-00-000Z_01a19999.jsonl",
            concat!(
                r#"{"type":"session","version":3,"id":"01a19999","cwd":"F:\\VibeCoding_workspace\\ModelHarbor","parentSession":"01a147ad"}"#,
                "\n",
            ),
        );
        write_session(&project.join("subagent-artifacts"), "run-0.jsonl", "{\"type\":\"artifact\"}\n");

        let payload = list_at(root.path()).unwrap();
        assert_eq!(payload.sessions.len(), 2, "{:?}", payload.sessions);
        assert!(payload.warnings.is_empty(), "{:?}", payload.warnings);
        let fork = payload.sessions.iter().find(|s| s.id == "01a19999").unwrap();
        assert_eq!(fork.parent_id.as_deref(), Some("01a147ad"));
    }

    #[test]
    fn missing_root_is_a_clear_error_not_an_empty_list() {
        let root = tempdir::TempDir::new("verta-pi-missing").unwrap();
        let error = list_at(&root.path().join("nope")).unwrap_err();
        assert!(error.contains("pi"), "unexpected error: {error}");
    }

    #[test]
    fn a_session_without_cwd_or_decodable_directory_is_reported() {
        let root = tempdir::TempDir::new("verta-pi-nowcwd").unwrap();
        let project = root.path().join("garbage");
        write_session(&project, "2026-10-17T02-24-43-071Z_01a147ad.jsonl", "{\"type\":\"session\",\"id\":\"x\"}\n");
        let payload = list_at(root.path()).unwrap();
        assert!(payload.sessions.is_empty());
        assert_eq!(payload.warnings.len(), 1);
    }
```

- [x] **Step 6: 跑测试确认通过**

Run:

```bash
cd /f/VibeCoding_workspace/Verta/src-tauri
cargo test -j 2 agent_sessions
```

Expected: PASS。

- [x] **Step 7: 提交**

```bash
cd /f/VibeCoding_workspace/Verta
git add src-tauri/src/modules/agent_sessions/pi.rs src-tauri/src/modules/agent_sessions/mod.rs
git commit -m "feat(agent-sessions): list pi sessions by scanning session jsonl files"
```

---

## Task 5: 命令注册（异步 + 阻塞池）

**Files:**
- Modify: `src-tauri/src/modules/agent_sessions/mod.rs`
- Modify: `src-tauri/src/lib.rs:273`

- [x] **Step 1: 实现命令**

`mod.rs` 补上：

```rust
use types::AgentSessionsPayload;

/// 读磁盘（sqlite / 目录扫描）一律走阻塞池，避免占用主线程与异步 worker。
#[tauri::command]
pub async fn agent_sessions_list(tool: String) -> Result<AgentSessionsPayload, String> {
    crate::modules::fs::blocking(move || match tool.as_str() {
        opencode::TOOL => opencode::list(),
        pi::TOOL => pi::list(),
        other => Err(format!("不支持的会话工具：{other}")),
    })
    .await
}
```

- [x] **Step 2: 注册**

`src-tauri/src/lib.rs` 的 `generate_handler!` 里，紧跟 `agent::agent_hooks_status,` 之后加一行（保持与 `mod.rs` 一致的字母序）：

```rust
            agent_sessions::agent_sessions_list,
```

顶部 `mod` 引用方式与既有条目一致（文件里已有 `agent::agent_enable_hooks` 这类写法，因此这里写 `agent_sessions::agent_sessions_list` 而不是 `modules::agent_sessions::…`）。

- [x] **Step 3: 编译 + 静态检查**

Run:

```bash
cd /f/VibeCoding_workspace/Verta/src-tauri
cargo clippy --all-targets --locked -- -j 2 -- -D warnings
cargo test -j 2 --locked agent_sessions
```

Expected: clippy 无 warning（`-D warnings` 会把 warning 变错误），测试全绿。

- [x] **Step 4: 提交**

```bash
cd /f/VibeCoding_workspace/Verta
git add src-tauri/src/lib.rs src-tauri/src/modules/agent_sessions/mod.rs
git commit -m "feat(agent-sessions): expose agent_sessions_list over ipc"
```

---

## Task 6: 前端纯函数：resume 命令拼装

**Files:**
- Create: `src/modules/launcher/lib/types.ts`
- Create: `src/modules/launcher/lib/resumeCommand.ts`
- Create: `src/modules/launcher/lib/resumeCommand.test.ts`

- [x] **Step 1: 写类型**

`types.ts`：

```ts
export type AgentTool = "opencode" | "pi";

export type AgentSession = {
  tool: AgentTool;
  id: string;
  title: string;
  cwd: string;
  updatedAtMs: number;
  parentId: string | null;
};

export type AgentSessionsPayload = {
  sessions: AgentSession[];
  warnings: string[];
};
```

- [x] **Step 2: 写失败的测试**

`resumeCommand.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { resumeCommand } from "./resumeCommand";

describe("resumeCommand", () => {
  it("passes the id and the directory to opencode", () => {
    expect(
      resumeCommand({
        tool: "opencode",
        id: "ses_f183332f5ffeNGzvkzJ631PU71",
        cwd: "F:/VibeCoding_workspace/GitShow",
      }),
    ).toBe(
      "opencode --session ses_f183332f5ffeNGzvkzJ631PU71 'F:/VibeCoding_workspace/GitShow'",
    );
  });

  it("quotes a path with spaces for opencode", () => {
    expect(
      resumeCommand({ tool: "opencode", id: "ses_1", cwd: "C:/Users/费马 大定理/Desktop" }),
    ).toBe("opencode --session ses_1 'C:/Users/费马 大定理/Desktop'");
  });

  it("resumes pi by session id only, because the terminal already has the cwd", () => {
    expect(
      resumeCommand({
        tool: "pi",
        id: "01a147ad-023f-71ff-b404-bb337dea4b63",
        cwd: "F:\\VibeCoding_workspace\\WorkBuddy",
      }),
    ).toBe("pi --session 01a147ad-023f-71ff-b404-bb337dea4b63");
  });

  it("never lets a session id break out of the command", () => {
    const command = resumeCommand({ tool: "pi", id: "x; rm -rf /", cwd: "F:/x" });
    expect(command).not.toContain("rm -rf");
  });
});
```

- [x] **Step 3: 跑测试确认失败**

Run:

```bash
cd /f/VibeCoding_workspace/Verta
pnpm vitest run src/modules/launcher/lib/resumeCommand.test.ts
```

Expected: FAIL，`Failed to resolve import "./resumeCommand"`。

- [x] **Step 4: 实现**

`resumeCommand.ts`：

```ts
import { quoteShellArg } from "@/lib/shellQuote";
import type { AgentTool } from "./types";

const SESSION_ID = /^[A-Za-z0-9_-]+$/;

type ResumeTarget = {
  tool: AgentTool;
  id: string;
  cwd: string;
};

/**
 * 会话 id 只会被拼进命令行，因此先按白名单校验；任何一个字符不合规都拒绝执行，
 * 而不是转义后放行。
 */
export function resumeCommand({ tool, id, cwd }: ResumeTarget): string {
  if (!SESSION_ID.test(id)) {
    throw new Error(`会话 id 含非法字符，拒绝构造 resume 命令：${id}`);
  }
  if (tool === "opencode") {
    // opencode 用 --session <id> + 位置参数 directory；cwd 必须一起传，
    // 否则会在当前目录里找不到这个会话而静默新建一个。
    return `opencode --session ${id} ${quoteShellArg(cwd)}`;
  }
  // pi 在 cwd 下按 id 找会话，所以 cwd 由终端的工作目录承担。
  return `pi --session ${id}`;
}
```

- `quoteShellArg` 来自 `src/lib/shellQuote.ts`（既有工具，App.tsx 的 `cd ${quoteShellArg(path)}` 已在用）。

- [x] **Step 5: 跑测试确认通过**

Run:

```bash
cd /f/VibeCoding_workspace/Verta
pnpm vitest run src/modules/launcher/lib/resumeCommand.test.ts
```

Expected: PASS（4 个）。

- [x] **Step 6: 提交**

```bash
cd /f/VibeCoding_workspace/Verta
git add src/modules/launcher
git commit -m "feat(launcher): build the resume command for opencode and pi"
```

---

## Task 7: 前端纯函数：相对时间

**Files:**
- Create: `src/modules/launcher/lib/relativeTime.ts`
- Create: `src/modules/launcher/lib/relativeTime.test.ts`

- [x] **Step 1: 写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import { relativeTime } from "./relativeTime";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  it("shows 刚刚 under a minute", () => {
    expect(relativeTime(1_000_000, 1_000_000 - 30_000)).toBe("刚刚");
  });
  it("shows minutes", () => {
    expect(relativeTime(1_000_000, 1_000_000 - 5 * MINUTE)).toBe("5 分钟前");
  });
  it("shows hours", () => {
    expect(relativeTime(1_000_000, 1_000_000 - 3 * HOUR)).toBe("3 小时前");
  });
  it("shows days", () => {
    expect(relativeTime(1_000_000, 1_000_000 - 2 * DAY - HOUR)).toBe("2 天前");
  });
  it("shows 30 天前 and beyond as a date", () => {
    expect(relativeTime(1_000_000, 1_000_000 - 40 * DAY)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("never shows a negative age for a clock that moved backwards", () => {
    expect(relativeTime(1_000_000, 1_000_000 + 5 * MINUTE)).toBe("刚刚");
  });
  it("handles a missing timestamp", () => {
    expect(relativeTime(1_000_000, 0)).toBe("时间未知");
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run:

```bash
cd /f/VibeCoding_workspace/Verta
pnpm vitest run src/modules/launcher/lib/relativeTime.test.ts
```

Expected: FAIL，无法解析 import。

- [x] **Step 3: 实现**

```ts
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ABSOLUTE_AFTER_DAYS = 30;

export function relativeTime(nowMs: number, updatedAtMs: number): string {
  if (!updatedAtMs || updatedAtMs <= 0) return "时间未知";
  const age = nowMs - updatedAtMs;
  if (age < MINUTE) return "刚刚";
  if (age < HOUR) return `${Math.floor(age / MINUTE)} 分钟前`;
  if (age < DAY) return `${Math.floor(age / HOUR)} 小时前`;
  const days = Math.floor(age / DAY);
  if (days < ABSOLUTE_AFTER_DAYS) return `${days} 天前`;
  const date = new Date(updatedAtMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
```

- [x] **Step 4: 跑测试确认通过**

Run:

```bash
cd /f/VibeCoding_workspace/Verta
pnpm vitest run src/modules/launcher/lib/relativeTime.test.ts
```

Expected: PASS（7 个）。

- [x] **Step 5: 提交**

```bash
cd /f/VibeCoding_workspace/Verta
git add src/modules/launcher
git commit -m "feat(launcher): add relative time formatting"
```

---

## Task 8: 前端纯函数：父子会话折叠

**Files:**
- Create: `src/modules/launcher/lib/sessionTree.ts`
- Create: `src/modules/launcher/lib/sessionTree.test.ts`

- [x] **Step 1: 写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import { foldSessions } from "./sessionTree";
import type { AgentSession } from "./types";

const session = (id: string, parentId: string | null, updatedAtMs: number): AgentSession => ({
  tool: "opencode",
  id,
  title: id,
  cwd: "F:/x",
  updatedAtMs,
  parentId,
});

describe("foldSessions", () => {
  it("keeps order and attaches children to their parent", () => {
    const rows = foldSessions([
      session("a", null, 30),
      session("child1", "a", 20),
      session("b", null, 10),
      session("child2", "a", 5),
    ]);
    expect(rows.map((row) => row.parent.id)).toEqual(["a", "b"]);
    expect(rows[0].children.map((child) => child.id)).toEqual(["child1", "child2"]);
    expect(rows[1].children).toEqual([]);
  });

  it("promotes a child whose parent is not in the list", () => {
    const rows = foldSessions([session("orphan", "missing", 10)]);
    expect(rows.map((row) => row.parent.id)).toEqual(["orphan"]);
  });

  it("never drops a session", () => {
    const input = [session("a", null, 3), session("b", "a", 2), session("c", "b", 1)];
    const rows = foldSessions(input);
    const seen = rows.flatMap((row) => [row.parent.id, ...row.children.map((c) => c.id)]);
    expect(seen.sort()).toEqual(["a", "b", "c"]);
  });

  it("tolerates a parent cycle without losing either session", () => {
    const rows = foldSessions([session("a", "b", 2), session("b", "a", 1)]);
    const seen = rows.flatMap((row) => [row.parent.id, ...row.children.map((c) => c.id)]);
    expect(seen.sort()).toEqual(["a", "b"]);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run:

```bash
cd /f/VibeCoding_workspace/Verta
pnpm vitest run src/modules/launcher/lib/sessionTree.test.ts
```

Expected: FAIL，无法解析 import。

- [x] **Step 3: 实现**

```ts
import type { AgentSession } from "./types";

export type SessionRow = {
  parent: AgentSession;
  children: AgentSession[];
};

/**
 * 子会话（子代理）默认折叠在父会话下。父不在列表里的会话按顶层处理，
 * 出现环时同样降级为顶层，保证任何一条会话都不会从界面上消失。
 */
export function foldSessions(sessions: AgentSession[]): SessionRow[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const children = new Map<string, AgentSession[]>();
  const roots: AgentSession[] = [];

  for (const session of sessions) {
    const parentId = session.parentId;
    if (parentId && byId.has(parentId) && parentId !== session.id) {
      const bucket = children.get(parentId);
      if (bucket) bucket.push(session);
      else children.set(parentId, [session]);
    } else {
      roots.push(session);
    }
  }

  const rows: SessionRow[] = [];
  const claimed = new Set<string>();
  const take = (session: AgentSession) => {
    if (claimed.has(session.id)) return;
    claimed.add(session.id);
    const kids = children.get(session.id) ?? [];
    rows.push({ parent: session, children: kids });
    for (const kid of kids) claimed.add(kid.id);
  };

  for (const root of roots) take(root);
  for (const session of sessions) take(session);

  for (const row of rows) {
    row.children.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }
  return rows;
}
```

- 第二轮 `for (const session of sessions) take(session)` 用来接住环里的会话（`a -> b -> a` 时两者都不在 `roots`）。

- [x] **Step 4: 跑测试确认通过**

Run:

```bash
cd /f/VibeCoding_workspace/Verta
pnpm vitest run src/modules/launcher/lib/sessionTree.test.ts
```

Expected: PASS（4 个）。

- [x] **Step 5: 提交**

```bash
cd /f/VibeCoding_workspace/Verta
git add src/modules/launcher
git commit -m "feat(launcher): fold subagent sessions under their parent"
```

---

## Task 9: 前端 IPC 出口 + 面板 UI

**Files:**
- Create: `src/modules/launcher/lib/sessions.ts`
- Create: `src/modules/launcher/components/SessionList.tsx`
- Create: `src/modules/launcher/components/LauncherPanel.tsx`
- Create: `src/modules/launcher/components/LauncherPanelLazy.tsx`
- Create: `src/modules/launcher/index.ts`

- [x] **Step 1: 写 IPC 出口**

`sessions.ts`：

```ts
import { invoke } from "@tauri-apps/api/core";
import type { AgentSessionsPayload, AgentTool } from "./types";

export function listAgentSessions(tool: AgentTool): Promise<AgentSessionsPayload> {
  return invoke<AgentSessionsPayload>("agent_sessions_list", { tool });
}
```

- [x] **Step 2: 写列表组件**

`SessionList.tsx`：

```tsx
import { cn } from "@/lib/utils";
import { foldSessions } from "../lib/sessionTree";
import type { AgentSession } from "../lib/types";

type Props = {
  sessions: AgentSession[];
  nowMs: number;
  activeId: string | null;
  onOpen: (session: AgentSession) => void;
  formatTime: (updatedAtMs: number) => string;
};

export function SessionList({ sessions, nowMs, activeId, onOpen, formatTime }: Props) {
  const rows = foldSessions(sessions);
  if (rows.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
        没有会话记录
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 px-1.5">
      {rows.map((row) => (
        <SessionRows
          key={row.parent.id}
          row={row}
          nowMs={nowMs}
          activeId={activeId}
          onOpen={onOpen}
          formatTime={formatTime}
        />
      ))}
    </div>
  );
}

function SessionRows({
  row,
  nowMs,
  activeId,
  onOpen,
  formatTime,
}: { row: ReturnType<typeof foldSessions>[number] } & Omit<Props, "sessions">) {
  return (
    <>
      <SessionButton
        session={row.parent}
        depth={0}
        active={row.parent.id === activeId}
        nowMs={nowMs}
        onOpen={onOpen}
        formatTime={formatTime}
      />
      {row.children.map((child) => (
        <SessionButton
          key={child.id}
          session={child}
          depth={1}
          active={child.id === activeId}
          nowMs={nowMs}
          onOpen={onOpen}
          formatTime={formatTime}
        />
      ))}
    </>
  );
}

function SessionButton({
  session,
  depth,
  active,
  onOpen,
  formatTime,
}: {
  session: AgentSession;
  depth: number;
  active: boolean;
} & Pick<Props, "onOpen" | "formatTime">) {
  return (
    <button
      type="button"
      title={`${session.cwd}\n${session.id}`}
      onClick={() => onOpen(session)}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none",
        "transition-colors duration-[var(--dur-base)] focus-visible:ring-2 focus-visible:ring-primary/40",
        active ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.045]",
      )}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      <span className="truncate text-xs text-foreground">{session.title}</span>
      <span className="truncate text-[10px] text-muted-foreground">
        {session.tool} · {formatTime(session.updatedAtMs)}
      </span>
    </button>
  );
}
```

- `nowMs` 由面板算一次并向下传，避免每行各读一次时钟。
- `formatTime` 也由面板注入，方便后面共用。

- [x] **Step 3: 写面板外壳**

`LauncherPanel.tsx`：

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { SessionList } from "./SessionList";
import { listAgentSessions } from "../lib/sessions";
import { relativeTime } from "../lib/relativeTime";
import type { AgentSession, AgentTool } from "../lib/types";

const TOOLS: { id: AgentTool; label: string }[] = [
  { id: "opencode", label: "opencode" },
  { id: "pi", label: "pi" },
];

type Props = {
  activeSessionId: string | null;
  onOpenSession: (session: AgentSession) => void;
};

export function LauncherPanel({ activeSessionId, onOpenSession }: Props) {
  const [tool, setTool] = useState<AgentTool>("opencode");
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const nowMs = Date.now();

  const refresh = useCallback(async (target: AgentTool) => {
    setLoading(true);
    setError(null);
    try {
      const payload = await listAgentSessions(target);
      setSessions(payload.sessions);
      setWarnings(payload.warnings);
    } catch (failure) {
      // 读不到就是读不到：保留上一次的结果，但必须把错误显出来，不能装作没有会话。
      setError(String(failure));
      setWarnings([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(tool);
  }, [refresh, tool]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter(
      (session) =>
        session.title.toLowerCase().includes(needle) ||
        session.cwd.toLowerCase().includes(needle),
    );
  }, [query, sessions]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        {TOOLS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTool(item.id)}
            aria-pressed={tool === item.id}
            className={cn(
              "cursor-pointer rounded-md px-2 py-1 text-[11px] outline-none transition-colors duration-[var(--dur-base)]",
              "focus-visible:ring-2 focus-visible:ring-primary/40",
              tool === item.id
                ? "bg-foreground/[0.07] text-foreground"
                : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void refresh(tool)}
          disabled={loading}
          className="ml-auto cursor-pointer rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {loading ? "读取中" : "刷新"}
        </button>
      </div>
      <div className="shrink-0 px-2 pb-1.5">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索标题或目录"
          className="w-full rounded-md border border-border/60 bg-transparent px-2 py-1 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
        />
      </div>
      {error ? (
        <div className="mx-2 mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
          {error}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SessionList
          sessions={visible}
          nowMs={nowMs}
          activeId={activeSessionId}
          onOpen={onOpenSession}
          formatTime={(updatedAtMs) => relativeTime(nowMs, updatedAtMs)}
        />
      </div>
      {warnings.length > 0 ? (
        <div className="shrink-0 border-t border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
          有 {warnings.length} 个会话文件无法解析
        </div>
      ) : null}
    </div>
  );
}
```

- `nowMs` 由面板算一次并向下传，避免每行各读一次时钟。
- `formatTime` 也由面板注入，方便后面共用。
- 错误用 `String(failure)` 呈现，这是本仓库既有写法（`src/modules/ai/lib/sessions.ts:167` 等处一致）；`@/lib/utils` 里只有 `cn` 与 `isMarkdownPath`，没有 `formatError`。

- [x] **Step 4: 写 barrel**

`index.ts`：

```ts
export { LauncherPanel } from "./components/LauncherPanel";
export type { AgentSession, AgentSessionsPayload, AgentTool } from "./lib/types";
```

- [x] **Step 5: 类型检查与 lint**

Run:

```bash
cd /f/VibeCoding_workspace/Verta
pnpm check-types
pnpm lint
```

Expected: 均通过。

- [x] **Step 6: 提交**

```bash
cd /f/VibeCoding_workspace/Verta
git add src/modules/launcher
git commit -m "feat(launcher): add the session list panel"
```

---

## Task 10: 接进左侧栏与 App 协调层

**Files:**
- Modify: `src/modules/sidebar/types.ts:1`
- Modify: `src/modules/sidebar/useSidebarPanel.ts:41`
- Modify: `src/modules/sidebar/SidebarRail.tsx:24`
- Modify: `src/app/App.tsx`

- [x] **Step 1: 加视图 id**

`src/modules/sidebar/types.ts`：

```ts
export type SidebarViewId = "explorer" | "source-control" | "launcher";
```

- [x] **Step 2: 加轨道按钮**

`src/modules/sidebar/SidebarRail.tsx` 的 import 改成：

```ts
import { FolderGitTwoIcon, FolderTreeIcon, MessageMultiple01Icon } from "@hugeicons/core-free-icons";
```

`MessageMultiple01Icon` 已确认存在于 `node_modules/@hugeicons/core-free-icons/dist/types/MessageMultiple01Icon.d.ts`。然后在 `items` 里加：

```ts
    { id: "launcher", label: "会话", icon: MessageMultiple01Icon },
```

- 中文标签符合「界面中文」的约定。

- [x] **Step 3: 三路渲染**

`src/app/App.tsx:1480` 的二元三目改成三路（保留既有两个分支不动，只加 launcher 分支并调整条件）：

```tsx
                      {sidebarView === "launcher" ? (
                        <LauncherPanel
                          activeSessionId={activeSessionId}
                          onOpenSession={handleOpenSession}
                        />
                      ) : sidebarView === "explorer" ? (
```

- [x] **Step 4: 实现 onOpenSession**

先在 `App.tsx` 顶部加引用（与既有 `@/modules/...` 导入并列）：

```tsx
import { LauncherPanel, type AgentSession } from "@/modules/launcher";
```

再加 state 与回调（放在 `launchAgentGroup` 附近，复用同一批依赖）：

```tsx
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const handleOpenSession = useCallback(
    (session: AgentSession) => {
      let command: string;
      try {
        command = resumeCommand(session);
      } catch (error) {
        console.error("[verta] 无法为该会话构造 resume 命令", error);
        return;
      }
      const { leafId } = newAgentTab(session.cwd, session.title);
      setActiveSessionId(session.id);
      void (async () => {
        await whenSessionReady(leafId);
        if (!writeToSession(leafId, `${command}\r`)) {
          console.error(`[verta] 终端 ${leafId} 在 resume 前已关闭`);
        }
      })();
    },
    [newAgentTab],
  );
```

需要补的 import：`resumeCommand` 来自 `@/modules/launcher/lib/resumeCommand`，`newAgentTab` 从 `useTabs()` 的解构里取（`useTabs` 返回值里已有 `newAgentTab`，见 `src/modules/tabs/lib/useTabs.ts:804`），`whenSessionReady` / `writeToSession` 从 `@/modules/terminal` 取（`App.tsx:99` 附近已导入 `whenSessionReady`）。

- `.cwd` 与 `.title` 与 id 一起用，满足 spec §5.1「(tool, session_id, cwd) 不可拆」。

- [x] **Step 5: 检查**

Run:

```bash
cd /f/VibeCoding_workspace/Verta
pnpm check-types
pnpm lint
pnpm test
```

Expected: 三项全通过。

- [x] **Step 6: 提交**

```bash
cd /f/VibeCoding_workspace/Verta
git add src/app/App.tsx src/modules/sidebar
git commit -m "feat(launcher): open a terminal at the session cwd from the sidebar"
```

---

## Task 11: 端到端验收

**Files:**
- Create: `docs/superpowers/shots/p1-01-sessions.png`

- [x] **Step 1: 起应用**

```bash
cd /f/VibeCoding_workspace/Verta
pnpm tauri dev
```

Expected: 窗口起来，左栏出现「会话」轨道按钮。

- [x] **Step 2: 截图**

```bash
cd /f/VibeCoding_workspace/Verta
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev/shot-window.ps1 -Out docs/superpowers/shots/p1-01-sessions.png
```

- [x] **Step 3: 逐条核对 spec §6 P1 的验收**

手工确认下列事项，任何一条不成立都不算通过：

1. 打开「会话」面板，默认页签 opencode 列出 10 条以上会话，含 `daily talk`、`PasteLabel Go`、`GitShow Go`、`bear_bill Go`，且子代理会话折叠在父会话下。
2. 切到 pi 页签，列出 4 条（ModelHarbor 1、WorkBuddy 2、portfolio 1），WorkBuddy 那条标题显示 `daily talk`。
3. 点 `GitShow Go`：新开的终端标签标题是 `GitShow Go`，终端里执行了 `opencode --session ses_f183332f5ffeNGzvkzJ631PU71 'F:/VibeCoding_workspace/GitShow'`，且**没有**新建会话。
4. 把 `~/.pi/agent/sessions` 临时改名，点刷新：面板显示明确错误，**不是**空列表；改回后刷新恢复。
5. `opencode` 库被占用时（可用一个 python 进程持写锁模拟）点刷新：显示明确错误，不是空列表。

- [x] **Step 4: 提交截图与交接记录**

```bash
cd /f/VibeCoding_workspace/Verta
git add docs/superpowers/shots/p1-01-sessions.png
git commit -m "docs: add the P1 session list screenshot"
```

---

## 验收标准（P1 完成的定义）

1. `cargo clippy --all-targets --locked -- -D warnings` 与 `cargo test --locked agent_sessions` 通过
2. `pnpm check-types` / `pnpm lint` / `pnpm test` 通过
3. opencode 与 pi 两个页签都能列出真实会话，且列表里的数据与直接查库/读文件一致
4. 点会话能在正确目录 resume（opencode 不新建会话，pi 用 id 恢复）
5. 三类失败（库打不开、目录不存在、单行解析失败）都在界面上可见，没有一处静默变成空列表
6. 截图存档在 `docs/superpowers/shots/`

---

## 已知取舍与后续

1. **pi 的时间用文件 mtime**，不是首行 timestamp，也不是最后一条消息的时间。mtime 够用且零依赖；若发现偏差明显，再考虑读文件尾部或引入日期库。
2. **pi 的 `updatedAt` 与排序**：opencode 用 `time_updated`，两者语义不同但都能回答"最近用过的"。
3. **前缀窗口 8 MiB / 100,000 行，命中第一个名字即停**：一个在 >8 MiB 处才被命名的会话会退回用首条 user 消息作标题；一个被改名多次的会话显示它较早的名字（本机 ModelHarbor 那条显示 `ModelHarber2` 而非后来的 `ModelHarber`）。原计划的 512 行 / 256 KiB 已被实测推翻，见 §0.5 第 6 条。
4. **不做置顶/重命名/隐藏**（spec §11.1 的暂定结论：P1 只做打开、复制 resume 命令、复制路径、资源管理器显示）。本计划只做了「打开」，另外三项留到 P1.1，因为它们是纯前端追加，不阻塞核心痛点。
5. **`opencode --session` 传错 id 会静默新建会话**：本计划靠白名单校验 id 形状 + 始终传 cwd 来降低风险，但没有从根上消除；后续可在打开后校验终端里是否出现新会话 id。

---

## 执行记录（2026-10-17，Task 1 到 11 全部完成）

### 门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| Rust 测试 | `cd src-tauri && cargo test -j 2 --lib agent_sessions` | **23 passed** |
| Rust 静态检查 | `cd src-tauri && cargo clippy --all-targets --locked -j 2 -- -D warnings` | **通过** |
| 前端 lint | `pnpm lint` | exit 0（0 error；89 warning 全为上游既有，新代码 0 warning） |
| 类型 | `pnpm check-types` | 通过 |
| 前端测试 | `pnpm exec vitest run --maxWorkers=2` | 220 文件 / 2048 用例通过，1 skipped |

### 验收结果（逐条对照 spec §6 P1）

| 验收项 | 结果 | 证据 |
|---|---|---|
| opencode 列出真实会话 | 8 条顶层（子代理按用户要求隐藏） | `shots/p1-05-state.png` |
| pi 列出真实会话 | 4 条，标题为 `ModelHarber2` / `daily talk` / `pelican` / `项目分析` | `shots/p1-06-pi-fixed.png` |
| 点会话在该目录 resume | 标签标题为会话名；终端提示符与面包屑是 `F:\VibeCoding_workspace\PasteLabel`；TUI 恢复出该会话历史 | `shots/p1-02-resume.png`；dev 日志 `pty cwd: F:\VibeCoding_workspace\PasteLabel` |
| 不静默新建会话 | 点击前后 `session_v2` 都是 18 行；被恢复的会话 `time_updated` 从 10-13 变为当天 21:47 | 见下 |
| 失败不伪装成空列表 | 3 个单测钉住（库不存在 / 目录不存在 / 无已知表） | `opencode.rs`、`pi.rs` |
| 会话名进入标签 | 标签 `PasteLabel Go` | `shots/p1-02-resume.png` |

「不新建会话」的核对方式：点击前后各跑一次 `SELECT COUNT(*) FROM session_v2`，都是 18；同时 `SELECT time_updated FROM session_v2 WHERE id='ses_0be16f2c8ffeFnRn5CVN2D7Xay'` 从 2026-10-13 变成 2026-10-17T21:47:24，证明是它被恢复而不是新建。

### 实现过程中发现并修掉的问题（按发现顺序）

1. **一个 pi 测试自身写错**：用例的 JSON 里塞了真实换行，导致该行不是合法 JSON（JSONL 按定义不含裸换行）。实现跳过它是正确的，测试改用 raw string，并补了"含裸换行的行必须被跳过"的守卫用例。
2. **计划漏项：`useSidebarPanel` 的视图白名单**（`readSidebarView`）→ 不加 `launcher` 会导致切到会话面板后重启回落。已修，并在重启后实测仍是会话面板。
3. **本机 CRLF 与 biome 冲突**（环境问题）→ 加 `.gitattributes`（`* text=auto eol=lf`）并重新检出，`pnpm lint` 从"对未改过的上游文件也报错"变成 exit 0。
4. **`dist-budget.test.ts` 硬编码产品 identifier**（被本项目的 identifier 改动打穿）→ 改为从 `src-tauri/tauri.conf.json` 读。
5. **`compositingBudget.test.ts` 的上游 Windows 路径 bug**（`new URL(...).pathname` 得到 `F:\F:\...`，整个文件 0 用例）→ 改用 `fileURLToPath`。
6. **`AdaptedGhosttyGpu.test.ts` 并行 flaky**（10 万次更新的 5 秒超时用例；单独跑 68/68 两次全过）→ 文档化 `--maxWorkers=2`。
7. **clippy 1.99 的两个新 lint**：我的 `sort_by` 改 `sort_by_key`；上游 `workspace.rs:448` 的 `chunks_exact(2)` 改 `as_chunks::<2>()`。
8. **pi 前缀窗口太小（真正的功能缺陷，靠 GUI 对照期望值才发现）**：256 KiB 窗口漏掉了写在文件深处的 `session_info.name`，4 个 pi 会话里有 2 个显示成原始 prompt。实测名字最晚在 3.98 MiB 处，改为 8 MiB / 100,000 行，并补两个边界用例。
9. **截图脚本在窗口最小化时静默截出废图**（160x28 的碎条）→ 先 `SW_RESTORE` 再截，并打印提示。

### 用户决策（覆盖 spec）

- **子代理会话不展示**（2026-10-17 用户指示，覆盖 spec §4.1 的"默认折叠"）。实现为 `topLevelSessions`：只在父会话也在列表里时才隐藏；父会话落到查询窗口之外的孤儿仍显示，避免因 `LIMIT 200` 丢会话。底部显示"已隐藏 N 个子代理会话"，以免用户看到数字对不上而困惑。
- 因不再需要折叠，已删除 `sessionTree.ts` 及其测试（新增 `visibleSessions.ts` 与其测试）。

### 遗留与观察

- 启动时若恢复了带运行中进程的标签，terax 会弹出 "Close Terminal?" 守卫框。这是上游既有行为（`CloseDialogs.tsx`），不是本次改动引入；观察到一次，未深究。
- GUI 错误态（pi 目录被改名 / opencode 库被占用）没有做破坏性验证，因为那要动用户的真实数据目录；该不变量由 3 个单元测试覆盖。
- `--session` 传错 id 时 opencode 会静默新建会话这一风险仍未从根上消除（见「已知取舍」第 5 条）。
