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

## 12. 追加需求（2026-10-17，用户提出）

### 12.1 会话删除与管理（P1.5，已出计划）

会话要支持**真删除**（不是隐藏），并给一个能看到**全部会话（含子代理）**的管理界面，支持多选删除。实现计划见 `docs/superpowers/plans/2026-10-17-verta-p1-5-session-management.md`。要点：前端只传 `{tool, id}`（不传路径）；opencode 走它自带的 `opencode session delete`（它会连带删除子会话）；pi 按扫描结果删文件与其产物目录；删除后必须重新扫描复核。

### 12.2 项目行的 agent / 会话入口（P2 范围）

参考 GitShow 项目行的 `⋯` 菜单（`GitShow/src/app/ui/shell.rs:617`：`ui.weak(说明)` + `ui.button(动作)` + `ui.close()`，打开类操作收进菜单以免撑宽列），在 Verta 的项目行上提供：

1. **右键 / `⋯` 菜单**：`用 opencode 打开`、`用 pi 打开`（随适配器扩展）、`在终端中打开`、`复制项目路径`。选中某个 agent 即在项目根目录开终端并启动该 agent 的交互式会话（不带 `--session`，因此是新建会话）。
2. **鼠标选中 / 悬停该行时弹出**：该项目下已有的会话列表（点一条即 resume，沿用 P1 的 `(tool, id, cwd)` 不可拆传递规则），以及一项 `新建会话`。
3. 归属匹配：会话的 `cwd`（opencode 的 `directory`、pi 首行的 `cwd`）与项目的 `root` 匹配；匹配不到任何会话的项目只显示 `新建会话`。

该需求把 P1 的会话数据与 P2 的项目列表连起来，因此排在 P1.5（会话管理）之后实现。

### 12.3 Git 面板放右侧（布局改动）

现状：git 面板是左栏三个视图之一（`explorer` / `source-control` / `launcher` 互斥），所以看项目列表时看不到 Git。用户要求 **Git 在页面右侧打开**，让「项目列表」与「Git」能同时看，并在右侧加一个与左上角对称的**隐藏/展开按钮**。

落点：

1. `App.tsx` 的 `ResizablePanelGroup` 现在是 `[sidebar | workspace]`，改为 `[sidebar | workspace | rightPanel]`，右面板 `collapsible` + `collapsedSize={0}`，默认收起，宽度与收起态持久化（对应左栏的 `terax.sidebar.*`，新增 `terax.rightPanel.*`）。
2. 左上角那个按钮是 `Header.tsx:124` 的 `Button variant="ghost" size="icon-sm"` + `HugeiconsIcon icon={SidebarLeftIcon}`；右侧按钮用同一套，图标换 `SidebarRightIcon`（hugeicons 里有）。
3. 右面板装 git 视图（现有 `SourceControlPanel`，P3 的 git 操作与提交图也进这里）；左栏只留 `explorer` 与 `launcher`，即 `SidebarViewId` 去掉 `source-control`，避免同一个面板有两处入口、两份状态。
4. 右面板默认收起：不改变现有用户"打开就看到 workspace"的习惯，需要看 Git 时点右上角展开。
### 12.4 Windows 与 WSL 并存 + WSL 开关

现状：terax 用 `Space.env = {kind:"windows"} | {kind:"wsl",distro}` 表达工作区环境，由状态栏的 `WorkspaceEnvSelector` 切换（`src/modules/workspace/env.ts:7`、`src/modules/statusbar/WorkspaceEnvSelector.tsx:40`），切换即整体换环境。用户要求**不再切换**：Windows 与 WSL 的**项目与会话同时展示**，并加一个 **WSL 开关**，点了就开启服务并显示 WSL 内的 opencode/pi 项目与会话，不点就关闭服务且不显示。

本机实况（已核实）：

| 项 | 结果 |
|---|---|
| 发行版 | 只有 `Ubuntu-22.04`，WSL2，调查时 State 已是 Running |
| WSL 内的 opencode 数据 | `/home/cxj/.local/share/opencode/opencode.db`，**3.3 GB**；`session_v2` 233 行 = **4 条顶层会话** + 229 条子代理会话；目录 `/home/cxj/workspace/mem0_chat_fastapi`（226 行）、`/home/cxj/workspace/ai-fusion-video`、`/home/cxj` |
| WSL 内的 pi 数据 | **没有**：WSL 里 `pi` 解析到 `/mnt/c/Users/费马大定理/.pi/agent/bin/pi`（Windows 的 pi），`~/.pi/agent/sessions` 不存在 |
| WSL 里的 `opencode` | 也是 Windows 那个：`/mnt/d/Softwaredata/npm-global/opencode`（interop 跑 exe）。它按 `HOME=/home/cxj` 写入 WSL 文件系统，这就是那 3.3 GB 的来源 |
| 从 Windows 读那个库 | `\\wsl.localhost\<distro>\...` 可读；`?mode=ro` 在 **14.4 秒后 database is locked**（9p 上拿不到 WAL 的 `-shm` 锁）；`?immutable=1` **0.03 秒成功**，但它会忽略未 checkpoint 的 WAL 尾巴 |
| WSL 里的 python3 | `/usr/bin/python3` 有；**没有** `sqlite3` CLI |

落点（关闭语义确认后再写实现计划）：

1. 会话列表改为**按来源分组展示**：Windows（现状）+ WSL（开关开启时才请求）。`SessionTarget` 要加 `distro: Option<String>`，否则 `{tool, id}` 无法区分两个仓库里同 id 的会话。
2. WSL 侧读会话走 **distro 内 python3 查询**（`wsl.exe -d <distro> -- python3 <脚本>`，脚本先落到 Windows 临时文件再经 `/mnt/c/...` 传入，以避开 wsl.exe 的参数引号转换）。这是 WAL 正确的读法；`immutable=1` 的 UNC 直读只作为 `-wal` 为 0 字节时的备选，因为它可能静默读到过期数据。
3. WSL 侧的**项目**来自会话的 `directory` 加上 `~/workspace` 下的目录；点击 WSL 会话恢复时要开 **WSL 终端**（`pty` 已有 `build_wsl(cwd, distro)`）。
4. pi 在 WSL 侧没有数据，界面要**如实说明**，不能显示成普通的空列表。
5. 开关的关闭语义是危险操作，待用户确认（见下）。

#### 关闭语义的决定（用户 2026-10-17 答复）

**在设置里加一个开关**，语义是"关闭 WSL 开关时做什么"：

| 设置开关 | 行为 |
|---|---|
| 关（默认） | 只停 Verta 的 WSL 查询：不再请求该发行版，列表里隐藏 WSL 项。不碰 WSL 本身，用户在 WSL 里跑的服务与容器不受影响 |
| 开 | `wsl --shutdown`：关掉**所有**发行版与 WSL2 工具 VM |

默认关，所以默认行为永远不会中断用户的东西；选了开就是一次明确同意，设置项的描述必须写明它会中断 WSL 里正在跑的一切（例如 Docker Desktop 的 WSL 后端）。因此关闭时不再额外弹确认框，但关闭结果要在界面上如实回报（成功与失败都显示，沿用 §5.5 不静默失败）。

### 12.5 删掉 terax 的内置智能体

用户要求"项目原有的内部智能体不要了"，范围已确认为**全删**：

| 目标 | 规模 | 处理 |
|---|---|---|
| `src/modules/ai/**` | 89 文件 / 14.7k 行 | 删（AI 侧栏、聊天、工具、store、模型设置界面） |
| `src/components/ai-elements/**` | 11 文件 / 2.7k 行 | 删（聊天 UI 基元，只有 AI 模块在用） |
| `src/modules/agents/**` | 27 文件 / 2.4k 行 | 删；**但 `lib/agentIcon.tsx` 要搬到 `src/modules/launcher/lib/`**，它是 R3 的工具图标组件 |
| `src-tauri/src/modules/ai_sessions.rs` | 1243 行 | 删，连同它的 5 个命令与 `SessionFilesState` |
| `src-tauri/src/modules/agent.rs` | 567 行 | 删（给 claude/codex/gemini 装终端钩子做跑完通知），连同 `agent_enable_hooks`、`agent_hooks_status` 与 `emit_conout_marker` 的调用点 |
| 连线 | 约 20 个文件 | 逐处摘除，例如 `App.tsx` 的 `useChatStore`/`panelOpen`/AI diff 审批/输入栏 composer、`Header.tsx` 的通知铃、编辑器 `autocomplete/provider.ts` 的 AI 补全、`settings/store.ts` 的模型与 API key 项 |

落点要求：

1. **一次删干净**：不留"只剩引用没人用"的模块、命令与设置项，也不留空面板。删完 `pnpm lint`、`pnpm check-types`、`pnpm exec vitest run --maxWorkers=2`、`cargo clippy --all-targets -j 2 -- -D warnings` 必须全绿。
2. 启动体积预算测试（`src/app/eager-budget.test.ts`、`src/app/dist-budget.test.ts`）会跟着变小，要确认它们断言的是上限而不是下限，否则会因为"变小"而失败。
3. **删代码不删用户数据**：`tauri-plugin-store` 里已存的模型 API key 保留在盘上不动（删代码不等于替你擦密钥；要擦另说）。AI 会话文件（`ai_sessions.rs` 管的那些）同样先不删，等确认后再清。
4. 删完把这些删除记进 `.superpowers/handoff.md` 的"与上游分歧"表，写清"这个 fork 不含内置智能体"，避免以后对账时把删除误判成漂移。

### 12.6 图片显示（R15，分三阶段）

用户要求"编辑器和终端都要能显示图片"。现状核实结果（决定了各阶段的工作量）：

| 落点 | 现状 | 结论 |
|---|---|---|
| 编辑器打开图片文件 | **已经能预览** png / jpg / jpeg / gif / webp / svg / ico，同分支还有视频 / 音频 / PDF，走 `convertFileSrc`，`assetProtocol` 已启用且 `scope: ["**"]` | 阶段一的工作是**验证并补齐**（尺寸信息、缩放、透明棋盘格已有），不是从零做 |
| Markdown 预览里的 `![](x.png)` | 依赖 streamdown 的渲染器；AI 删除后 `markdown-code` 已搬出，但**图片组件没有专门适配本地路径** | 阶段二：本地相对路径要按 Markdown 文件所在目录解析，并与工作区鉴权（`workspace` 模块的 cwd 白名单）一致，不能任意读盘 |
| 终端内显示图片 | 终端是 **ghostty（WebGPU）自绘**，不是 xterm；仓库里没有 kitty / iTerm2 图形协议的实现 | 阶段三：最重的一项。要么实现 kitty graphics 协议，要么退化为"识别路径并可点击→打开预览标签" |

分阶段计划：

1. **阶段一（编辑器）**：真机验证 + 补齐体验（缩放、错误态、大图提示），并让 `.svg` 走图片渲染以外的正确分支（svg 是文本，走 `<img>` 会丢掉代码查看能力，需要"预览/源码"切换）。
2. **阶段二（Markdown / 代码内联）**：Markdown 里的本地图片按文档目录解析并渲染；代码里引用的图片路径给出缩略图或点击打开。
3. **阶段三（终端）**：先做"路径可点击 → 打开预览"，再评估 kitty graphics 协议（ghostty 后端是否留了 hook，需要先查 `AdaptedGhostty*` 的渲染入口）。

安全约束（沿用 §5）：三个阶段都不得绕过工作区鉴权。图片读取一律走已被 `WorkspaceRegistry` 授权的根目录，禁止凭路径直接读任意文件。

### 12.6.1 Markdown 表格内图片的尺寸规则（R15，已定）

同一表格内的图片必须满足三条，缺一不可：

1. **表格随页面等比缩小**：窗口变窄时整张表跟着缩，不允许溢出、不允许出现横向滚动条。
2. **同一表格内图片高度一致**：允许横向留白，不允许一行高一行低。
3. **不拉伸**：等比缩放，比例恒定。

实现（`MarkdownImage.tsx` 的 `useTableSizing`）：以**表格宽度**为唯一输入，除以“含图片的列数”得到每列可用宽度；每列图按自身比例算出铺满该列的所需高度，全表取最小值作为统一行高；再按该行高与自身比例给出 px 宽高。表格宽度由容器决定，所以窗口变小 → 表格变小 → 图片变小，三者同比例。

踩过的三个坑，不要再走：

- **不能用单元格宽度算图片宽度**：单元格尺寸来自内容，会与表格宽度互相反馈，结果是表格长到超出页面、宽度到页边就停住不再缩小。
- **不能给图片百分比宽度**：`td` 是自动布局，百分比宽会把表格撑宽，同样溢出。
- **不能只按高度排布而不限制宽度**：会得到 1422px 的表塞进 1018px 的容器，右侧被裁。
- 另注：streamdown 给表格滚动容器写了行内 `max-height: 300px`，行内样式 class 覆盖不了，已在 `globals.css` 用 `.markdown-doc .markdown-rendered [style*="max-height"] { max-height: none !important }` 解除；不解除时表格底部会被下一段内容盖住。

### 12.7 编辑器右侧实时预览（R16）

在编辑器右边缘加一个可折叠的预览列，像 Typora 那样边看边改。默认收起，点编辑器右上角的 `Preview` 打开。

| 文件类型 | 预览内容 |
|---|---|
| Markdown | 渲染后的文档，跟随编辑实时更新 |
| 图片 | 缩略图 |
| 其他 | 不显示这个入口（而不是给一个空面板） |

要点：

1. 预览必须复用同一套渲染（`MarkdownImage` 的路径解析、`MarkdownCode` 的代码块），不能另写一份，否则两边的图片与代码块行为会分叉。
2. 预览列本身要能滚动，并在滚动条上标出当前可视行位置，点击可跳过去。
3. 编辑器与被预览的文档共享同一份内容，不重复读盘。

### 12.8 界面语言：中文与英文（R17）

用户要求界面上能切换中文与英文，**不做日韩**。已确认：**默认跟随系统语言**，**只翻界面可见文案**（代码注释、日志、agent 名称与命令名不翻）。

已定实现（`src/modules/i18n/`）：

- `language.ts`：`LanguagePref = "system" | "zh" | "en"`；`resolveLanguage` 把 `zh-*` 一律判为中文，其余为英文，缺省（`undefined`）也落到英文，所以 `zh-Hant-TW` 不会掉进英文。
- `messages.ts`：两张表以 `zh` 为类型基准（`MessageKey = keyof typeof zh`），英文表被强制要求定义同一批键；`translate` 支持 `{name}` 占位，占位缺值就原样保留，不打印 `undefined`。
- `index.ts`：`useLanguage()` / `useT()`，语言来自 `preferences` 的 `language` 字段，切换立即重渲染、不需重启。
- 偏好新增 `language`（默认 `"system"`），设置页「通用」里有下拉。
- 测试强制两张表键集合相等且无空串，避免某种语言下出现空标签。

进度：

| 模块 | 状态 |
|---|---|
| 侧栏轨道（Sessions / Files / Git） | 已翻 |
| 会话面板（含删除确认框、错误提示、计数） | 已翻 |
| 设置页语言选项 | 已加 |
| 设置页其余文案（约 36 处上游英文） | 待翻 |
| 终端 / Git / 资源管理器 / 命令面板等 | 待翻 |

原文保留如下（历史决定记录）：

用户要求界面上能切换中文和英文，**不做日韩**。

现状（决定了工作量）：

- 项目里**没有任何 i18n 基建**（没有 `react-intl`、`i18next`、`lingui`）。
- 需要抽取的文案分布：上游原有英文界面文案约 103 处（`title` / `label` / `placeholder` / `aria-label`），本 fork 新写的中文文案 15 处。
- 注意 `overrideLanguage` 是"文件语言"（代码高亮），与界面语言无关，不要混用。

落点：

1. 选一个轻量方案（键值表 + `t()` 函数即可，不上重型框架），默认语言取系统语言，存进 `tauri-plugin-store`，与现有偏好同处。
2. 文案按模块集中到 `zh` / `en` 两份表，`t("launcher.manage")` 这类 key 命名带模块前缀。
3. 先做**设置页里的语言选项 + 会话面板与侧栏**（改动面小、能立刻验收），再分模块补齐。每补完一个模块，把该模块的写死文案清零。
4. 日期与相对时间（`relativeTime.ts` 目前输出"13 小时前"这类中文）走同一套切换。
5. 不做的事：不翻译日志、不改代码注释语言、不翻译 agent 名称与命令名。
