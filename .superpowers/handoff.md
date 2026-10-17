# Verta 交接说明（2026-10-17）

## 一句话

把 GitShow（项目/git/GitHub）+ Coffee-CLI 的「本机 agent 会话列表」+ terax-ai（终端/编辑器/源码管理）合并成一个 Windows 优先的桌面工作台。**设计已定，实现未开始。**

## 设计文档

`docs/superpowers/specs/2026-10-17-verta-design.md`（尚未 git 提交：新仓库还没 `git init`，P0 里连代码一起提交）

## 已定决策

- 宿主 = terax-ai fork（Apache-2.0），仓库 `F:\VibeCoding_workspace\Verta`
- 平台：Windows 优先，最后出 NSIS 安装包
- 第一版五项全要：会话列表（核心）、项目列表、查看改动 + git 操作、文件编辑器、GitHub 面板
- 会话列表首发支持 **opencode + pi**（本机只有这两家有真实会话数据）
- **不复用 Coffee-CLI 的任何代码/资源**（AGPL-3.0），只照其交互与落盘格式自行实现

## 基线（对账用）

| 仓库 | commit | 日期 | 用途 |
|---|---|---|---|
| terax-ai | `1a68067` | 2026-10-16 | fork 起点（v0.9.0 迁移 libghostty/WebGPU 进行中，注意漂移） |
| Coffee-CLI | `6ff1f0b` | 2026-10-14 | 只读参考：会话列表交互、扫描清单、`SavedSession` 字段语义 |
| GitShow | `325a5eb` | 2026-10-12 | 搬 Rust 代码的来源（git CLI 封装、GitHub 走 `gh` CLI） |

GitShow 当前状态：工作区干净、与 `origin/main` 同步（0 领先）、版本号 `0.0.1`。本轮界面问题（长分支名撑宽列、三栏不可调宽、工作区右栏溢出卡片盖住圆角）已在其后续提交中修完（`a40a09a`/`ace25df`/`ecbaeab`/`d1f8b9f`/`325a5eb`）。

## 下一步：P0（已于 2026-10-17 完成，见文末「P0 实况」）

```bash
# 1) 起新仓库：Verta/ 目录已存在（只放了 docs/ 与 .superpowers/），
#    所以要复制上游「内容」进来（带 /.），而不是把整个 terax-ai 目录嵌进来。
#    复制会把上游的 .git 一起带过来，随后删掉并重新 init，另设 upstream 便于对账。
cp -r /f/VibeCoding_workspace/GitProject/terax-ai/. /f/VibeCoding_workspace/Verta/
cd /f/VibeCoding_workspace/Verta && rm -rf .git && git init
git remote add upstream file:///f/VibeCoding_workspace/GitProject/terax-ai
git add -A && git commit -m "Import terax-ai 1a68067 as the Verta baseline"

# 2) 装依赖并构建（需联网）
pnpm install
cd src-tauri && cargo build -j 2      # 内存受限，必须限并行
cd .. && pnpm tauri dev               # 验收：窗口起来 + 能开一个终端
```

之后按 spec §6 的 P1…P6 逐期做；每期开工前用 writing-plans 生成实现计划，每期结束截图验收。

## 环境约束与坑

- 本机空闲内存约 4.9 GB：Rust 编译一律 `-j 1~2`，并行会 OOM；偶发 `E0463` 用 `cargo clean -p <crate>` 恢复。磁盘充足（630 GB）。
- **子代理故障**：2026-10-17 当天 testing 子代理连续报 `Variant unavailable for opencode/mimo-v2.6-flash-free: max`，测试派发失败。用户约定测试一律交子代理执行；需要换子代理或等模型侧恢复。
- 首次 `pnpm install` 与 Tauri 构建需要联网。
- 不擅自 `push`；版本号由用户决定（GitShow 曾因子代理擅自升到 0.1.0 被要求回退）。
- 桌面上的 `GitShow.exe` 是拷贝，每次 release 构建后要手动覆盖同步。

## 用户偏好（跨会话有效）

- 界面中文、提交信息英文。
- **不写长段设计说明式注释**（设计进文档，代码只留必要的「为什么」）。
- 不做全量重排式格式化：GitShow 侧不跑 `cargo fmt`；Verta 侧沿用 terax 既有 biome/clippy 配置，也不对上游代码重排。
- 测试：2026-10-17 起改为**主助手自己做**（配置里的子代理持续 `Variant unavailable`，见文末「P1 开工须知」）。
- **子代理会话不展示**（2026-10-17）：会话列表只列顶层会话，子代理（子会话）完全不显示；覆盖 spec §4.1 的"默认折叠"。实现见 `src/modules/launcher/lib/visibleSessions.ts`。
- 危险操作（删除、强制推送、重置）先确认。

## 未决事项（spec §11）

1. 会话列表是否做置顶/重命名/隐藏（暂定 P1 只做：打开、复制 resume 命令、复制路径、资源管理器显示）。
2. terax 的 AI 侧栏保留但默认收起是否可接受（暂定：是）。
3. 项目清单与 terax 的 Space 是否同源（暂定：同源，Space 承载项目根 + 新增状态列）。
4. 上游 terax 对账节奏。

## P0 实况（2026-10-17 完成）

- 基线提交：`1cd3921 Import terax-ai 1a68067 as the Verta baseline`
- 仓库 `F:\VibeCoding_workspace\Verta`，remote `upstream = file:///F:/VibeCoding_workspace/GitProject/terax-ai`
- `pnpm install --frozen-lockfile`：51.6 秒 / 927 包；实际用的是 lockfile 声明的 **pnpm 11.9.0**（corepack 生效，不是全局 11.20.0）
- Rust 首次全量编译：**11 分 18 秒**（`cargo build -j 2`，无 E0463）
- 验收：`pnpm tauri dev` 起窗成功，日志出现 `pty opened id=1 cols=135 rows=61`（终端确实开起来了）

### 与上游的已知分歧（对账时只需看这几项）

| 项 | 上游 | Verta | 原因 |
|---|---|---|---|
| `src-tauri/tauri.conf.json` 的 `identifier` | `app.crynta.terax` | `app.verta` | 本机装着正式版 terax（`D:\Softwaredata\Terax\terax.exe`）。同 identifier 会让 dev 构建读写用户真实数据、并抢同一个 WebView2 profile，实测导致我们的 app 启动后异常退出。换独立 identifier 后两者可共存 |
| `.gitattributes` | 无 | `* text=auto eol=lf` | 本机全局 `core.autocrlf=true` 会把工作区检出成 CRLF，而 biome 要求 LF，导致 `pnpm lint` 对**未改过的上游文件**也报错；CRLF 还会破坏 `.sh` 脚本。加它之后工作区恒为 LF，`pnpm lint` 退出码 0 |
| `src/styles/compositingBudget.test.ts` | `new URL("..", import.meta.url).pathname` | `fileURLToPath(new URL("..", import.meta.url))` | 前者在 Windows 上得到 `F:\F:\...`，`readdirSync` 直接 ENOENT，整个测试文件 0 用例（既有上游 bug，与本项目无关） |
| `src/app/dist-budget.test.ts` | 硬编码 `TERAX_BENCH_IDENTIFIER: "app.crynta.terax"` | 从 `src-tauri/tauri.conf.json` 读 `identifier` | 硬编码在改 identifier 后守卫失效，误把 benchmark 产物判成违规。改成读配置后不再与产品标识耦合 |
| `docs/superpowers/`、`.superpowers/`、`scripts/dev/` | 无 | 有 | Verta 自有文档与开发脚本 |

其余 1041 个文件与上游**逐字节一致（含权限位）**。对账命令：

```bash
cd /f/VibeCoding_workspace/Verta
bash scripts/dev/upstream-drift.sh                             # 离线，比 index 的 mode + blob + 路径
git fetch --depth=1 upstream && git diff upstream/main --stat   # 在线
```

### 上游是浅克隆（对账注意事项）

上游 `GitProject\terax-ai` 是 **depth-1 浅克隆，只有 1 个 commit**。普通 `git fetch upstream` 会被拒（`shallow roots are not allowed to be updated`），必须带 `--depth=1`；这会把 Verta 自身也标成 shallow（`.git/shallow` 写入 `1a68067`），属已知副作用。因此**拿不到上游中间历史，对账只能比 tip**。

## P1 开工须知（2026-10-17 补充）

### 数据契约修正（必读，spec §4 有 4 处与实况不符）

详见 `docs/superpowers/plans/2026-10-17-verta-p1-sessions.md` 第 0 节。最关键一条：**opencode 要读 `session_v2` 而不是 `session`**（前者是活表，含当天会话；后者是迁移前旧表，最后写入停在 10-14，spec 的示例行正是从这张旧表抄的）。照 spec 实现会得到陈旧列表并静默漏掉新会话。

### 环境与工具

- **子代理**：`explore` 与兜底代理持续报 `Variant unavailable for opencode/...: max` 不可用；`testing` 代理本次能跑通但不可依赖。用户 2026-10-17 明确：**不用配置里的子代理，主助手自己做**。
- **截图脚本 `scripts/dev/shot-window.ps1` 必须按可执行文件路径过滤进程**（`-ExeMatch target\debug\terax.exe`）。只按进程名 `terax` 会抓到你已装的正式版窗口，产出假证据。
- **本机同时运行着正式版 terax**：涉及 `%APPDATA%\app.crynta.terax` 的任何读写都要当作危险操作。P0 期间我们的 dev 构建曾写入过该目录（`terax-spaces.json` / `terax-ai-sessions.json` / `terax-settings.json` / `.window-state.json` 在 21:17:44 被写过）。事后核对：2 个 space 的元数据与 state 键一致，标签齐备，**未发现数据丢失**；备份在 `~/verta-p0-terax-store-backup-20261017-211927/`，换 identifier 后不会再触碰。

### 门禁命令（本机实测）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 前端 lint | `pnpm lint` | exit 0（0 error；89 warning 全是上游既有，新代码 0 warning） |
| 类型 | `pnpm check-types` | 通过 |
| 前端测试 | `pnpm exec vitest run --maxWorkers=2` | 220 文件 / 2048 用例通过，1 skipped |
| Rust 测试 | `cd src-tauri && cargo test -j 2 --lib agent_sessions` | 21 passed |
| Rust 静态检查 | `cd src-tauri && cargo clippy --all-targets --locked -j 2 -- -D warnings` | 见 P1 记录 |

**必须限并发跑前端测试**：`pnpm test`（不限并发）时 `src/modules/terminal/ghostty/AdaptedGhosttyGpu.test.ts` 的"10 万次更新"用例会因 5 秒超时挂掉；单独跑该文件 68/68 两次全过，属本机内存（空闲 4-5 GB）与并行争抢。所以本机用 `--maxWorkers=2`。

**Rust 编译一律 `-j 2`**：加 rusqlite 后首次构建含 libsqlite3-sys 的 bundled C 代码，默认并行度有 OOM 风险。

## P1 实况（2026-10-17 完成）

会话列表面板已可用：左栏轨道第三个按钮「会话」，opencode / pi 两个页签，点一条会话就在它自己的目录里开终端并 resume。

- 门禁：Rust 23 测试通过 + clippy 通过；前端 `pnpm lint` exit 0、`pnpm check-types` 通过、`pnpm exec vitest run --maxWorkers=2` 220 文件 / 2048 用例全绿
- 验收证据：`docs/superpowers/shots/p1-*.png`；详细记录见 `docs/superpowers/plans/2026-10-17-verta-p1-sessions.md` 的「执行记录」
- 实测确认的关键行为：点 `PasteLabel Go` 后 `session_v2` 行数不变（18 → 18），且该会话 `time_updated` 从 10-13 变成当天 21:47，即真的 resume 而不是新建

### P1 期间新增的与上游分歧

见上文「与上游的已知分歧」表：`identifier`、`.gitattributes`、`compositingBudget.test.ts`、`dist-budget.test.ts`，外加 `src-tauri/src/modules/workspace.rs:448` 的 `chunks_exact(2)` → `as_chunks::<2>()`（clippy 1.99 的新 lint，上游代码在本机工具链下必然报错）。

### P1 期间修正的两条数据契约（重要，P2/P3 会用到）

1. **pi 的会话名不在文件开头**：`session_info.name` 出现在用户命名的那一刻，本机实测最晚在 3.98 MiB 处（一个 4.18 MB 的会话）。前缀窗口必须是 MiB 级（现为 8 MiB / 100,000 行，命中第一个名字即停）。原计划的 512 行 / 256 KiB 会让 4 个会话里的 2 个显示成原始 prompt。
2. **子代理会话不展示**（用户指示，见「用户偏好」）。

### 工具脚本（`scripts/dev/`）

| 脚本 | 用途 | 注意 |
|---|---|---|
| `upstream-drift.sh` | 与上游对账（比 index 的 mode + blob + 路径） | 离线可用；上游是浅克隆，`git fetch` 必须带 `--depth=1` |
| `shot-window.ps1` | 抓我们窗口的截图（PrintWindow） | **必须按可执行文件路径过滤**（本机装着正式版 terax）；窗口最小化时会先 `SW_RESTORE` |
| `click-window.ps1` | 在客户区点一次（用于验收需要交互的界面） | 点完会还原光标位置 |

### 下一步：P2（项目列表 + 状态列 + 点击进工作区）

P2 要比 P1 轻：`git_status` 等命令 terax 已有（`src-tauri/src/modules/git/commands.rs`），要加的是状态列的并发刷新与「进工作区」动作。注意 spec §4.4 与 §11.3（项目清单是否与 Space 同源，暂定同源）。

### 界面语言现状

「界面中文」目前只在新代码里落地（会话面板的标签、占位符、空态、错误文案）。**继承自上游的界面文案（Files / Git / Open 等）仍是英文**，需要单独一轮翻译，不属 P1 范围。代码注释按上游风格用英文（只有面向用户的字符串用中文）。