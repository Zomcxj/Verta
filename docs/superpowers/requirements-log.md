# Verta 需求台账（用户口头需求的登记处）

- 建立日期：2026-10-17
- 用途：用户在对话里随时提出的需求都登记在这里。**上下文被压缩后以本文件为准**，每条都指向它落在设计文档、计划或提交里的位置。
- 维护约定：用户每提一条新需求，先登记再动手；需求变化时改这一行，不另起文件。

## 1. 长期约定（一直有效）

| 编号 | 约定 | 来源 |
|---|---|---|
| C1 | 界面文案中文，提交信息英文 | 用户 |
| C2 | 不写长段设计式注释；设计进文档，代码只留必要的"为什么" | 用户 |
| C3 | `TERAX.md` 的 No em-dash 适用于 Verta 全部文档（含中文文档） | terax 约定 |
| C4 | 危险操作（删除、强制推送、重置、关闭 WSL 服务）先确认或由用户明确授权 | 用户 + 设计文档 §5.4 |
| C5 | 不使用子代理执行工作（本机配置里的 explore/fallback 持续报 `Variant unavailable ... : max`） | 用户 |
| C6 | 不复用 Coffee-CLI 的任何代码与资源（AGPL-3.0），只参考其交互与落盘格式 | 用户 + 设计文档 §9 |
| C7 | 不对上游代码做全量重排式格式化。`pnpm format:check` 对 20 个**上游**文件的既有偏差不修 | 用户 |
| C8 | 内存受限：Rust 编译一律 `CARGO_BUILD_JOBS=2`（`-j 2`），前端全量测试一律 `--maxWorkers=2` | 本机实况 |
| C9 | 截图验收用 `scripts/dev/shot-window.ps1`，必须按可执行文件路径过滤（`-ExeMatch target\debug\terax.exe`），否则会抓到你已装的正式版 terax 窗口 | 本机实况 |
| C10 | **测试期间绝不删真实会话**。Rust 测试一律用临时目录/临时 sqlite；GUI 验收只做到"确认框出现 + 点取消"；真实删除必须由用户明确指定目标后才做，且只删指定的那一条，删完逐条比对 id 列表证明只少了那一条 | 用户（2026-10-17） |

## 2. 需求台账

| 编号 | 需求（用户原话要点） | 状态 | 落点 |
|---|---|---|---|
| R1 | 打开就是会话面板，会话放轨道第一位 | 已完成 `b0b37a3` | 侧栏默认视图与轨道顺序 |
| R2 | 不要 opencode/pi 切换，合成一个列表 | 已完成 `bbd242a` | `LauncherPanel` 用 `Promise.allSettled` 并行取两个工具，单工具失败不清空另一个 |
| R3 | 每行工具名改成图标 | 已完成 `bbd242a` | `src/modules/agents/lib/agentIcon.tsx`（opencode 用从发行版提取的官方 wordmark） |
| R4 | 子代理会话不展示（覆盖设计文档 §4.1 的"默认折叠"） | 已完成 `0e0742a` `bbd242a` | `launcher/lib/visibleSessions.ts` 的 `topLevelSessions` |
| R5 | 图标有点大 | 已完成 | `agentIcon.tsx` 按光学配重调小 |
| R6 | 会话底部不要写"隐藏子代理会话" | 已完成 | `LauncherPanel` 底部只留条数与解析失败数 |
| R7 | 支持删除会话（参考 Coffee-CLI） | **成功路径已真机验证**（用户授权删一条子代理会话，证据见计划 Task 7）；前端与 UI 已完成 | `plans/2026-10-17-verta-p1-5-session-management.md` |
| R8 | 给一个全部会话的管理界面，包括子代理会话 | 计划已写，未实现 | 同上 Task 5、Task 6 |
| R9 | 支持多选删除 | 计划已写，未实现 | 同上 Task 5、Task 6 |
| R10 | 注意要删除数据，不是隐藏会话 | 已按此设计：opencode 走它自带的 delete、pi 删文件与其产物目录、**删除后必须重新扫描复核** | 同上 §1 安全规则 |
| R11 | 参考 GitShow：项目支持右击弹窗选哪个 agent 打开；鼠标选中时弹出现有会话或新建会话 | 待实现 | 设计文档 §12.2 |
| R12 | Git 放页面右侧打开，项目列表和 Git 都能查看；右侧加一个如左上角一样的隐藏展开按钮 | 待实现 | 设计文档 §12.3 |
| R13 | Windows 和 WSL 不要切换，支持同时打开；加 WSL 开关，点击开启服务并显示 WSL 内的 opencode/pi 项目会话，不点击则关闭 WSL 服务且不显示 | 待实现（关闭语义已定） | 设计文档 §12.4 |
| R14 | 项目原有的内部智能体不要了 | **已完成** `3c6c2a1`：删 131 文件约 2.3 万行（AI 侧栏与聊天、模型设置与密钥、编辑器 AI 补全、终端钩子、`ai_sessions.rs`、`agent.rs`、`agent_detect.rs`），保留了与 AI 无关的 native 封装、代码块渲染、工具图标与多面板终端布局 | 设计文档 §12.5、施工计划 `plans/2026-10-18-verta-r14-remove-builtin-agent.md` |
| R15 | 编辑器和终端还不支持显示图片，需要修改 | **阶段一、二已完成**：编辑器图片可显示并带尺寸/缩放；Markdown 图片路径解析、表格内等比缩放与统一行高均已完成（规则见 §12.6.1）。**阶段三（终端显示图片）未开始** | 设计文档 §12.6、§12.6.1 |
| R16 | 打开的文件增加侧边预览小窗和滚动条 | 待实现（形态已定：编辑器右侧实时预览，如 Typora） | 设计文档待补 §12.7 |
| R17 | 后续要增加语言切换，**只做中文和英文**（不做日韩） | **基本完成**：全量界面文案已入表（轨道、会话面板、设置页、终端区块、命令面板、Git、预览、资源管理器、工作区、标签页、顶栏、LSP、状态栏）。默认跟随系统语言，切换即时生效 | 设计文档 §12.8 |
| R18 | 通用设置里「登录时启动」不要了，点击相关功能也要删除 | **已完成**：开关、enable/disable 调用、偏好字段与键、Rust 插件注册、Cargo 依赖、两处能力配置全部移除 | 提交 `c8b18d4` |

## 3. 用户已拍板的决定

| 日期 | 决定 | 出处 |
|---|---|---|
| 2026-10-17 | 会话列表隐藏子代理会话 | 用户（覆盖设计文档 §4.1） |
| 2026-10-17 | WSL 开关的关闭语义放进**设置**：关（默认）只停 Verta 的 WSL 查询，不碰 WSL 本身；开则 `wsl --shutdown`（关掉所有发行版与 WSL2 工具 VM）。默认关，所以默认可中断性为零 | 设计文档 §12.4 |
| 2026-10-17 | 内部智能体**全删**：AI 侧栏与聊天、模型设置与 API key、编辑器 AI 补全、`ai_sessions.rs` 及其命令，约 2 万行 | 设计文档 §12.5 |
| 2026-10-17 | 终端钩子（`agent.rs` 给 claude/codex/gemini 装钩子做"跑完通知"）**一起删** | 设计文档 §12.5 |
| 2026-10-17 | 执行顺序：**P1.5 收尾 → 删内部智能体 → WSL 并存 → Git 右置 → P2 项目行** | 用户 |

## 4. 已定的技术结论（不要重新调研）

| 项 | 结论 | 证据 |
|---|---|---|
| opencode 会话表 | 要读 **`session_v2`**，`session` 是迁移前旧表 | 实机查询 |
| pi 会话文件 | `<root>/<编码cwd>/<ISO>_<uuid>.jsonl` | 实机扫描 |
| pi 的 fork 位置 | `<root>/<编码cwd>/<stem>/forks/*.jsonl`，**不是** `<root>/<编码cwd>/forks/`。本机因此有 2 条 fork 从来没被列出来过（`6b2b909` 修） | 实机扫描 |
| pi 会话的产物目录 | 同名目录 `<stem>/` 装 `<uuid>/run-0/...` 与该会话的 forks；`subagent-artifacts/` 是共享目录，任何情况都不许删 | 实机扫描 |
| pi 的子代理运行记录 | `<stem>/<uuid>/run-0/session.jsonl`（本机 16 个）。文件名也叫 session.jsonl，但它们是子代理运行的记录，**刻意不列为会话**：只扫 `<项目>/*.jsonl` 与 `<项目>/<stem>/forks/*.jsonl` 两层 | 实机扫描 + `pi.rs` 的 `session_files` |
| UI 验收的可靠手段 | 用 WebView2 远程调试口读 DOM 并触发点击（`scripts/dev/webview-eval.mjs` + `scripts/dev/probes/`），比按像素点坐标可靠。启动方式：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 pnpm tauri dev`。像素点击仍可用，但坐标要从截图逐列扫描取，别目测 | 本机踩到 |
| pi 标题优先级 | `session_info.name` → 首条 user 消息 → 目录名；名字最晚出现在约 3.98 MB 处，前缀窗口 8 MiB / 100,000 行 | 实机实测 |
| opencode 删除 | 走 `opencode session delete <id>`（自带"删会话及其子会话"）；未知 id 退出码 1 + `Session not found: <id>` | 实机验证 |
| opencode 在 Windows 的可执行形态 | PATH 上是 npm 垫片 `opencode.cmd` → `node_modules/@opencode/cli/bin/opencode.exe`；`CreateProcess` 不认 `.cmd`，所以要走 `cmd /C opencode ...` | 实机查证 |
| 会话删除的安全边界 | 前端只传 `{tool, id}`（不传路径）；id 过 `^[A-Za-z0-9_-]+$` 白名单；pi 的目标必须证明在 pi root 之内；删除后重新扫描复核才敢报成功 | 计划 §1 |
| WSL 发行版 | 只有 `Ubuntu-22.04`（WSL2），用户 `cxj` | `wsl.exe -l -v` |
| WSL 内的 opencode 数据 | `/home/cxj/.local/share/opencode/opencode.db`，3.3 GB；`session_v2` 233 行 = 4 条顶层会话 + 229 条子代理；目录都在 `/home/cxj/workspace/*` | 实机只读查询 |
| WSL 内的 pi 数据 | **没有**：WSL 里 `pi` 解析到 `/mnt/c/Users/.../.pi/agent/bin/pi`（Windows 的 pi），`~/.pi/agent/sessions` 不存在 | `which pi` |
| 从 Windows 读 WSL 那个库 | `\\wsl.localhost\<distro>\...` 可读；`?mode=ro` 14.4 秒后 `database is locked`（9p 拿不到 WAL 的 `-shm` 锁）；`?immutable=1` 0.03 秒成功但会忽略未 checkpoint 的 WAL 尾巴 | 实机实测 |
| WSL 内的查询工具 | 有 `/usr/bin/python3`，**没有** `sqlite3` CLI | `which` |
| 内部智能体的清单 | 前端 `src/modules/ai`（89 文件 14.7k 行）+ `src/components/ai-elements`（2.7k 行）+ `src/modules/agents`（2.4k 行，含 R3 的 `agentIcon.tsx`，须搬走）+ Rust `src-tauri/src/modules/ai_sessions.rs`（1243 行）与 `agent.rs`（567 行） | 实机清点 |
| 本机路径陷阱 | bash 的 `/tmp` 是 `%TEMP%`，而 Windows 版 python 的 `/tmp` 是 `C:\tmp`（不存在）；MSYS 会把单引号脚本里的 `$c`、`$( )` 提前吃掉。跨 bash/python 一律用 `$HOME` 或仓库内路径，脚本用 `chr(92)` 构造 UNC | 实机踩到 |

## 5. 与上游 terax 的有意分歧

见 `.superpowers/handoff.md` 的对账表（含 `identifier` 改 `app.verta`、`.gitattributes`、两个测试的 Windows 适配等）。R14 落地后会新增一批"删除上游模块"的分歧，届时记入同一张表。