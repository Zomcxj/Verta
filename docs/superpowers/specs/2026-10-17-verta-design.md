# Verta 设计（合并 GitShow + Coffee-CLI 的会话列表 + terax-ai）

- 日期：2026-10-17
- 状态：设计已确认（用户批准），待写实现计划
- 新仓库：`F:\VibeCoding_workspace\Verta`（尚未创建，P0 建立）

## 1. 背景与目标

用户目前并用三个工具管理自己的 15 个本地项目：

| 工具 | 位置 | 栈 | 用户实际用它做什么 |
|---|---|---|---|
| GitShow | `F:\VibeCoding_workspace\GitShow` | Rust + egui | 项目列表与状态总览、git 全操作、GitHub（Actions/Releases/CI）、文件预览编辑 |
| Coffee-CLI | `F:\VibeCoding_workspace\GitProject\Coffee-CLI` | Tauri + React 19 + xterm.js | 多 AI CLI 并行、**本机 agent 会话列表**、Changes 面板、hooks |
| terax-ai | `F:\VibeCoding_workspace\GitProject\terax-ai` | Tauri 2 + React 19 + CodeMirror 6 + xterm.js(WebGL) | 终端、代码编辑器、源码管理与提交图、文件浏览器、AI 侧栏 |

真实痛点（用户原话）：**「有会话记录，点击直接打开，不用找项目」**；以及 Coffee-CLI 的缺口 **「Coffee CLI 就是不支持文件夹编辑和 GIT 管理」**。

目标：一个 Windows 优先的桌面工作台，覆盖三家能力，打开它就是「项目 + 会话」两个清单。

非目标（明确不做）：

- 不复用 Coffee-CLI 的任何代码或资源（AGPL-3.0，见 §9），只照其**交互与落盘格式**自行实现。
- 不做 Coffee 的动态岛、渠道集成（微信等）、11 语言包。
- 不换终端内核（继续 terax 的 xterm.js/WebGL），不换编辑器内核（继续 CodeMirror 6）。
- 不保证 macOS/Linux（先保证 Windows）。
- 不给 terax 的 AI 侧栏（BYOK）加新功能；保留但默认收起。

## 2. 能力归属（三家的哪些部分留下）

| 能力 | 来源 | 在 Verta 的形态 |
|---|---|---|
| 本机 agent 会话列表 | Coffee-CLI | 新模块（读 opencode SQLite、扫 pi 会话目录），启动器页签之一 |
| 项目管理（多项目 + 状态） | GitShow | 扩展 terax 的 `Space`（已有 `root`），加分支/未提交/上游状态列 |
| 终端 | terax | 原样使用；新增「带初始命令与 cwd 的终端标签」用于恢复会话 |
| 文件编辑器 | terax | 原样使用；P4 补 GitShow 的自动保存/撤销栈/备份习惯 |
| 查看项目修改 + git 操作 | terax + GitShow | terax 的 source control/提交图 + GitShow 的储藏、摘取、撤销、worktree、逐文件 diff |
| GitHub 面板 | GitShow | 新模块：登录态、Actions、Releases、CI、源码归档与附件下载 |
| 命令面板 / 主题 / 文件浏览器 / LSP | terax | 原样保留 |

## 3. 架构

宿主：**terax-ai fork**（Apache-2.0），Tauri 2 + React 19 + Vite + xterm.js + CodeMirror 6。
仓库：`F:\VibeCoding_workspace\Verta`，与上游 `GitProject\terax-ai` 分开，保持可对照。

### 3.1 Rust 侧（`src-tauri/src/modules/`）

| 模块 | 状态 | 内容 |
|---|---|---|
| `agent_sessions.rs` | 新增 | `list_sessions(tool) -> Vec<AgentSession>`；opencode 适配器（只读 SQLite）、pi 适配器（扫目录）；按 tool 注册，加新工具=加适配器 |
| `projects.rs` | 新增 | 项目注册表（根目录、名称、最近打开）；后台刷新每项目 git 状态（分支/未提交数/上游 ahead-behind） |
| `git_ext.rs` | 新增或并入现有 git | 储藏（list/push/apply/drop）、摘取、撤销、worktree（list/add/remove）、按文件 diff、`head_and_parent` |
| `github.rs` | 新增 | 登录态查询、Actions/Releases/CI 查询、源码归档与 Release 资产下载、配置读写 |
| `pty`, `workspace.rs`, `fs`, `lsp`, `proc`, `store` | 复用 | 终端、工作区鉴权、文件、语言服务、进程、配置存储（`tauri-plugin-store`） |

依赖：terax 现有 `portable-pty 0.9`、`reqwest 0.13`、`tauri-plugin-store`；**需新增 `rusqlite`（`bundled` 特性，避免依赖系统 sqlite）**。

搬入的 GitShow 代码是 Rust 且**通过 `Command::new("git")` 调用 git CLI**（`GitShow/src/git.rs:38`），因此可近乎原样移植，只改 IPC 命令层与错误类型。

### 3.2 前端（`src/modules/`）

| 模块 | 状态 | 内容 |
|---|---|---|
| `launcher` | 新增 | 左栏「项目 / 会话」两页签 + 搜索；会话行显示 tool 图标、标题、项目、相对时间 |
| `projects` | 扩展 spaces | Space 已有 `{id,name,root,env,createdAt,updatedAt}`，加状态列与「进工作区」动作 |
| `source-control`/`git-history` | 扩展 | 储藏/摘取/撤销/worktree 按钮与确认框（交互照 GitShow 的既有确认框语义） |
| `github` | 新增 | Actions/Releases/CI 面板、登录与下载 |
| 其余（terminal/editor/explorer/lsp/command-palette/theme） | 复用 | 不重写 |

### 3.3 数据流

```
前端 launcher ──invoke('agent_sessions_list')──> Rust agent_sessions
                                                 ├─ opencode: ~/.local/share/opencode/opencode.db（只读，仅小表）
                                                 └─ pi: ~/.pi/agent/sessions/**/session.jsonl（扫目录+读首尾）
点击一条会话 ──invoke('terminal_open', {cwd, argv})──> pty 起进程（cwd 必须是会话自己的目录）
前端 projects ──invoke('projects_list_with_status')──> Rust projects（后台并发 git status，增量回推）
```

## 4. 数据契约（均已在用户机器上核实）

### 4.1 opencode

- 库：`~/.local/share/opencode/opencode.db`（**5.6 GB**，含 WAL/SHM 旁文件）。
- 相关表：`session`(10 行)、`project`(25 行)、`project_directory`、`message`(**18200 行，禁止全表扫**)。
- `session` 字段：`id, project_id, workspace_id, parent_id, slug, directory, path, title, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, metadata, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, revert, permission, agent, model, time_created, time_updated, time_compacting, time_archived`。
- `project` 字段含 `worktree, name, time_updated`。
- 时间戳为 epoch 毫秒；示例行：
  - `ses_ed6e85fbbffeT4W4k8QrbRRT94` / `daily talk` / `C:/Users/费马大定理/Desktop`
  - `ses_0be16f2c8ffeFnRn5CVN2D7Xay` / `PasteLabel Go` / `F:/VibeCoding_workspace/PasteLabel`
  - `ses_f183332f5ffeNGzvkzJ631PU71` / `GitShow Go` / `F:/VibeCoding_workspace/GitShow`
  - `ses_0cfd7cbccffe6KV8iH8X7npL4b` / `bear_bill Go` / `F:/VibeCoding_workspace/bear_bill`
  - 子代理会话有 `parent_id` 非空（如「调研 X-AnyLabeling ONNX 推理 (@explore subagent)」），列表默认折叠子会话。
- 恢复：`opencode --session <id> <directory>`（`directory` 就是会话所属项目，因此「不用找项目」成立）。
- `opencode session list` **只列当前项目**，跨项目列表必须读库。
- 约束：只读连接 + 必带 `LIMIT`；库被占用/加锁时给出明确提示，不返回静默空列表。

### 4.2 pi

- 目录：`~/.pi/agent/sessions/--<编码后的 cwd>--/<ISO 时间戳>_<uuid>/.../session.jsonl`，另有 `forks/*.jsonl`；目录名解码即 cwd（例：`--F--VibeCoding_workspace-ModelHarbor--` → `F:\VibeCoding_workspace\ModelHarbor`）。
- 已存在的项目目录：`ModelHarbor`、`portfolio`、`WorkBuddy`、`Desktop`、`C:\Users\费马大定理`。
- 另有 `~/.pi/agent/run-history.jsonl` 与 `missions/index/*.json`（含 `projectRoot/title/status/updatedAt`）。
- 恢复：`pi --session <path|id>`（也支持 `--session-id <id>`、`--continue`）。

### 4.3 其他 agent（本机未产生会话数据，留适配器位）

- 已安装：`opencode`（`@opencode/cli@2.0.29`）、`codebuddy`（`@tencent-ai/codebuddy-code@2.93.2`，只有 `~/.codebuddy/logs`）、`@deepseek-ai/dsh`。
- **未安装 Claude Code**（`~/.claude` 不存在）。
- Coffee-CLI 的扫描清单可作参考（`claude/hermes/codex/qwen/opencode/openclaw` + 注册表里的 pi/kimi/grok/mimo/kilo）；其 `SavedSession { id, name, tool, cwd, session_token, saved_at, created_at, file_path, turn_count }` 可作为我们统一结构的字段参照。

### 4.4 项目状态

- 命令：`git status --porcelain=v1 -b`（含分支与 ahead/behind）、`git rev-list --count`、`git stash list` 等；沿用 GitShow 的解析函数（`parse_status_line`、重命名取新路径等已修过的坑）。
- 并发：沿用 GitShow 的有界并发后台刷新（其 `run_parallel`/`check_one_project` 模型）。
- 项目清单来源：terax `Space`（已有 `root` 与 WSL env）+ 用户现有 15 个项目。

### 4.5 GitHub

- GitShow 的 GitHub 认证**走本机 `gh` CLI**（`gh auth status`、`gh auth logout --hostname`），API 调用集中在 `GitShow/src/actions.rs`（`api.github.com`）。
- 移植时保持「用本机已有凭据」这一语义，不新造凭据存储；配置沿用 `tauri-plugin-store`。

## 5. 关键交互与安全规则

1. **恢复会话**：点击会话行 → 打开终端标签，cwd = 会话记录的 `directory`，命令 = 该 tool 的 resume 形式。**cwd 与会话 id 必须成对传递**：Coffee-CLI 源码注释里记着这个坑，`--resume <token>` 在错误目录下会静默 resume 到别的项目。我们实现时把 (tool, session_id, cwd) 作为一个不可拆的单元传递，并在终端标签标题上显示会话名。
2. **进工作区**：点击项目行 → 切换/创建 Space（`root` = 项目根），恢复该 Space 的标签与 cwd。
3. **看改动**：源码管理面板列出工作区文件 → 逐文件 diff → 逐 hunk 暂存/取消 → 提交（沿用 terax 已有能力，补 GitShow 的按文件视角）。
4. **危险操作一律二次确认**（沿用 GitShow 的确认框语义）：丢储藏、删 worktree、撤销提交、软撤回、删除分支、强制推送、丢弃工作区改动。
5. **不静默失败**：git/HTTP/DB 错误必须显示为错误状态，不得伪装成「工作区干净」「无会话」这类正常空态（GitShow 审查中修过的 P0 缺陷，同类问题不得在新项目复现）。

## 6. 分期计划（每期可独立启动验证）

| 期 | 交付 | 验收方式 |
|---|---|---|
| P0 | 复制 terax-ai 到 `Verta`，`pnpm install` + `cargo build` 通过，能开一个终端 | 启动截图 |
| P1 | 会话列表（opencode + pi）+ 点击恢复；适配器接口与 fixture 测试 | 点「GitShow Go」→ 终端在该目录 resume |
| P2 | 项目列表 + 状态列 + 点击进工作区 | 15 个项目状态与 `git status` 一致 |
| P3 | 查看改动 + git 操作（暂存/提交/储藏/摘取/撤销/worktree + 提交图） | 逐项操作后 `git log`/`git stash list`/`git worktree list` 核对 |
| P4 | 编辑器增强（自动保存、撤销栈、备份、图片/Markdown 预览） | 编辑中断后内容不丢 |
| P5 | GitHub 面板（登录态、Actions、Releases、CI、下载） | 在真实仓库跑一遍 |
| P6 | Windows 安装包（NSIS） | 装完能跑 |

## 7. 测试与验证策略

- Rust：新增模块的**纯函数单测**（opencode 行映射、pi 目录名解码、git 状态解析）+ **临时目录/临时 sqlite 的集成测试**；绝不在测试里读写用户真实 `opencode.db` 或 `~/.pi`（真实库只读路径用 fixture 复制一份小库覆盖）。
- 前端：`pnpm test`（vitest，terax 已配好）。
- 端到端：`pnpm tauri dev` + 截图脚本（沿用 GitShow 的 PrintWindow 思路，不依赖前台焦点），逐期截图给用户看。
- 测试执行一律交 testing 子代理（用户约定）；主助手只做代码与验证结论的复核。

## 8. 工程约定

- 工具链：node 24.15 / pnpm 11.20 / cargo 1.99 / rustc 1.99（本机已具备）。
- 格式与静态检查：**沿用 terax 既有配置**（`pnpm lint`、`format` 走 biome；`pnpm check-types` 走 tsc；Rust 用 `cargo clippy`），不新引入规则，也不对上游代码做全量重排。
- 内存：本机空闲约 4.9 GB，Rust 编译必须限制并行（`-j 1~2`）；前端构建正常。
- 发布：先 Windows；安装包用 terax/Coffee 都有的 Tauri 打包配置（NSIS）。
- 注释风格：不为设计说明写长段注释，设计进本文档，代码只留必要的「为什么」。

## 9. 许可与署名

| 项目 | 许可 | 处理 |
|---|---|---|
| GitShow（本人作品） | MIT | 搬入的 Rust 代码保留版权与许可声明 |
| terax-ai（宿主） | Apache-2.0 | 保留 LICENSE/NOTICE 与出处说明 |
| Coffee-CLI | **AGPL-3.0** | **不复制任何代码/资源**；会话扫描按公开可观测的落盘格式自行实现 |

## 10. 风险与取舍

1. opencode 库 5.6 GB：只读 + 小表查询；加锁时明确报错。
2. Tauri 首次构建耗内存与时间：P0 单独一期，避免与功能改动混在一起。
3. 会话恢复依赖各 CLI 的 resume 语义（opencode `--session <id> <dir>`、pi `--session <path|id>`），未来 CLI 升级可能改参数：适配器把「命令拼装」集中在一处，并用测试固定参数形状。
4. 上游 terax 仍在活跃开发（0.9.0 迁移到 libghostty/WebGPU）：fork 后需要定期对账，避免长期漂移；P0 先记录基线 commit。

被否决的方案（记录理由）：

- **以 Coffee-CLI 为骨架**：52.8k 行（terax 的 4 倍），含大量无关机制；许可会传染成 AGPL；编辑器需从零接。
- **以 GitShow 为骨架（egui）**：egui 无成熟终端控件（要接 `alacritty_terminal`），编辑器远弱于 CodeMirror，且会话列表与终端渲染全要自建，达不到「终端编辑器」目标。
- **新外壳 + 三家 Rust 复用 + 前端重写**：成熟 UI 重写成本远超收益。

## 11. 未决事项（待用户确认）

1. 会话列表要不要做置顶/重命名/隐藏（Coffee 有这三项；暂定 P1 只做：打开、复制 resume 命令、复制路径、在资源管理器中显示）。
2. terax 的 AI 侧栏保留但默认收起是否可接受（暂定：是）。
3. 项目清单与 terax 的 Space 是否合并为同一份数据（暂定：同源，Space 承载项目根，另加状态列）。
4. 上游对账策略（多久同步一次 terax 上游）。