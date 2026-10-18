# Verta P0（导入 terax-ai 基线并跑通）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 terax-ai `1a68067` 的完整内容导入 `F:\VibeCoding_workspace\Verta`，建立干净的单提交历史，并让 `pnpm install` + `cargo build` + `pnpm tauri dev` 全部跑通（窗口起来、能开终端）。

**Architecture:** P0 是纯"取基线"动作，不改任何上游代码逻辑。Verta 仓库采用**全新历史**（首个提交 "Import terax-ai 1a68067 as the Verta baseline"），上游 terax-ai 通过 `upstream` remote 保留，便于后续 `git diff upstream/main` 对账漂移。P0 结束时的仓库内容必须与上游 commit 逐字节等价，这样"哪些是我们改的"永远一目了然。

**Tech Stack:** Tauri 2 / Rust 1.99 / React 19 / Vite / pnpm 11 / Git Bash（Windows）/ PowerShell（截图验收）

---

## 已核实的环境事实（本计划据此编写，非推测）

| 项 | 实测值 |
|---|---|
| 上游路径 | `/f/VibeCoding_workspace/GitProject/terax-ai` |
| 上游 commit | `1a68067c22d2c42fce9bccfc1ea4e4a22ddfdd30`（`nix: update sources to 0.9.0 (#1354)`，2026-10-16） |
| 上游工作区 | 干净；tracked 文件 1041 个 = 磁盘文件 1041 个（无未跟踪/被忽略残留） |
| 上游分支 | `main` |
| 上游 `.git` 大小 | 11 MB（整个目录 30 MB） |
| node / pnpm | v24.15.0 / 11.20.0（`package.json` 声明 `pnpm@11.9.0`，但本机未启用 corepack 强制） |
| cargo / rustc | 1.99.0 / 1.99.0 |
| git | 2.55.0.windows.2，`core.autocrlf=true`，`core.symlinks=false` |
| git identity | Zomcxj / cxjlucky1121@163.com |
| 索引中的符号链接 | 0 个（`git ls-files -s` 无 `120000` 模式；`AGENTS.md`、`CLAUDE.md` 都只是内容为 `TERAX.md` 的普通小文件） |
| `node_modules` | 不存在（需全新安装） |
| `src-tauri/target` | 不存在（需全新编译） |
| 逻辑 CPU / 空闲内存 | 12 / 5.47 GB |
| F: 盘空闲 | 629 GB |
| `file://` remote 可用性 | `git ls-remote file:///F:/VibeCoding_workspace/GitProject/terax-ai` 可正常返回 `refs/heads/main` |

### 对计划有影响的两个上游机制（已读源码确认）

1. **sidecar 缺失不会挡住 debug 编译**：`src-tauri/build.rs` 的 `configure_sidecar()` 在 `PROFILE != release` 且 `binaries/terax-cli-<target>.exe` 不存在/为空时，会把 `TAURI_CONFIG` 里的 `bundle.externalBin` 清空后继续；只有 release 才 `panic!`。所以 **P0 允许直接 `cargo build`，不必先跑 `pnpm build:cli`**。
2. **`cargo build` 会顺带编译 CLI**：`src-tauri/Cargo.toml` 的 `default-members = [".", "crates/terax-cli", "crates/terax-control-protocol"]`，因此 Task 5 的 `cargo build` 已把 `terax-cli` 编译好；Task 6 的 `pnpm build:cli:dev`（`beforeDevCommand` 的一部分）此时只是把产物拷进 `src-tauri/binaries/`，很快。

---

## 文件结构（P0 结束时的形态）

```
F:\VibeCoding_workspace\Verta\
├── .git\                                    # 新建：全新历史，单提交
├── .superpowers\handoff.md                  # 已存在（Verta 专有）
├── docs\superpowers\specs\2026-10-17-verta-design.md   # 已存在（Verta 专有）
├── docs\superpowers\plans\2026-10-17-verta-p0-baseline.md  # 本文件（Verta 专有）
├── docs\superpowers\shots\                  # 新建：验收截图（Verta 专有）
│   └── p0-01-window.png
├── scripts\dev\shot-window.ps1              # 新建：PrintWindow 截图助手（Verta 专有，改编自 GitShow/scripts/shot.ps1）
└── <上游 1041 个文件原样>\                   # 不修改、不重排、不改名
```

**P0 明确不做的事**：不改 `productName` / `identifier` / `version`（另见下方"待确认"）、不动 biome/clippy 配置、不跑 `cargo fmt`、不重排任何上游文件。

---

## Task 0: 记录基线指纹（防呆，1 分钟）

**Files:** 无改动

- [x] **Step 1: 确认上游仍是干净基线**

```bash
cd /f/VibeCoding_workspace/GitProject/terax-ai
git rev-parse HEAD
git status --porcelain
git ls-files | wc -l
```

Expected:
- `rev-parse HEAD` → `1a68067c22d2c42fce9bccfc1ea4e4a22ddfdd30`
- `status --porcelain` → 无输出
- `ls-files | wc -l` → `1041`

若任一不符，**停下来汇报**（上游已漂移，需要重新确认基线）。

---

## Task 1: 导入上游内容并初始化 Verta 仓库

**Files:**
- Create: 上游全部 1041 个文件（复制）
- Delete: `F:\VibeCoding_workspace\Verta\.git`（复制过来的上游 `.git` 副本）
- Create: `F:\VibeCoding_workspace\Verta\.git`（`git init` 重建）

- [x] **Step 1: 复制上游内容（含上游 `.git`，随后删除重建）**

```bash
cp -r /f/VibeCoding_workspace/GitProject/terax-ai/. /f/VibeCoding_workspace/Verta/
```

Expected: 无输出（成功）。复制的是"内容"而非整个 `terax-ai` 目录（用的是源路径末尾的 `/.`），所以不会出现 `Verta/terax-ai/` 嵌套。

- [x] **Step 2: 校验复制完整性**

```bash
find /f/VibeCoding_workspace/Verta -path '*/.git' -prune -o -type f -print | wc -l
ls -d /f/VibeCoding_workspace/Verta/src-tauri /f/VibeCoding_workspace/Verta/package.json /f/VibeCoding_workspace/Verta/AGENTS.md
```

Expected: 文件数 `1044`（上游 1041 + Verta 专有 3 个：`.superpowers/handoff.md`、`docs/superpowers/specs/2026-10-17-verta-design.md`、`docs/superpowers/plans/2026-10-17-verta-p0-baseline.md`），三个路径都存在。

- [x] **Step 3: 删除上游 `.git` 副本并重建（全新历史）**

```bash
rm -rf /f/VibeCoding_workspace/Verta/.git
cd /f/VibeCoding_workspace/Verta && git init -b main
```

Expected: `Initialized empty Git repository in F:/VibeCoding_workspace/Verta/.git/`

> 注意：`rm -rf` 只作用于 Verta 的 `.git` 副本，用的是绝对路径，不会碰上游仓库。上游 `.git` 在 Task 0 已确认存在，删除后仍应存在（Step 4 会校验）。

- [x] **Step 4: 挂上游 remote 并确认目标仓库完好**

```bash
cd /f/VibeCoding_workspace/Verta
git remote add upstream file:///F:/VibeCoding_workspace/GitProject/terax-ai
git remote -v
git ls-remote upstream refs/heads/main
ls -d /f/VibeCoding_workspace/GitProject/terax-ai/.git
```

Expected:
- `remote -v` → `upstream  file:///F:/VibeCoding_workspace/GitProject/terax-ai (fetch/push)`
- `ls-remote` → `1a68067c22d2c42fce9bccfc1ea4e4a22ddfdd30  refs/heads/main`
- 上游 `.git` 仍存在

---

## Task 2: 校验导入保真度（关键闸门）

把 Verta 的 index 与上游 index 逐条比对 blob 哈希。`core.autocrlf=true` 下 `git add` 会把 CRLF 工作区内容规范化成与上游完全相同的 blob，因此**哈希必须逐行相等**。

**Files:** 无改动（只填 index）

- [x] **Step 1: 暂存全部内容**

```bash
cd /f/VibeCoding_workspace/Verta && git add -A
git ls-files | wc -l
```

Expected: `1044`

- [x] **Step 2: 与上游 index 逐条比对**

```bash
cd /f/VibeCoding_workspace/Verta
diff <(git -C /f/VibeCoding_workspace/GitProject/terax-ai ls-files -s | sort -k4) <(git ls-files -s | sort -k4)
```

Expected 输出**恰好**是这 3 行新增（内容哈希可能不同，只看路径）：

```
> 100644 <sha> 0	.superpowers/handoff.md
> 100644 <sha> 0	docs/superpowers/plans/2026-10-17-verta-p0-baseline.md
> 100644 <sha> 0	docs/superpowers/specs/2026-10-17-verta-design.md
```

- [x] **Step 3: 若出现任何其他差异，停止并汇报**

任何额外的 `<` 行（上游有、Verta 缺）或 `>` 行（Verta 多/哈希不同）都意味着复制或换行规范化出问题，必须先查清，不得直接提交。

---

## Task 3: 提交基线

**Files:** Create: `F:\VibeCoding_workspace\Verta\.git` 首个提交

- [x] **Step 1: 提交**

```bash
cd /f/VibeCoding_workspace/Verta
git commit -m "Import terax-ai 1a68067 as the Verta baseline"
git log --oneline
git status --porcelain
```

Expected:
- 提交成功，`git log --oneline` 只有一行
- `git status --porcelain` 无输出（无残留未跟踪文件）

- [x] **Step 2: 确认上游未被污染**

```bash
cd /f/VibeCoding_workspace/GitProject/terax-ai
git status --porcelain
git rev-parse HEAD
```

Expected: 无输出 + `1a68067c22d2c42fce9bccfc1ea4e4a22ddfdd30`

---

## Task 4: 安装前端依赖

**Files:** Create: `node_modules/`（不提交）

- [x] **Step 1: 安装（锁死 lockfile，保证基线可复现）**

```bash
cd /f/VibeCoding_workspace/Verta
pnpm install --frozen-lockfile
```

Expected: 结束行类似 `Done in 1m 23.4s`，生成 `node_modules/`；`pnpm-lock.yaml` **不被修改**（用 `git status --porcelain` 复核，应仍为空）。

需要联网。若报 `minimumReleaseAge` 相关错误（`pnpm-workspace.yaml` 里 `minimumReleaseAge: 4320` + `minimumReleaseAgeStrict: true`）：临时把 `minimumReleaseAgeStrict` 改成 `false` 后重装，装完改回。

- [x] **Step 2: 校验工具链可用**

```bash
cd /f/VibeCoding_workspace/Verta
pnpm exec vite --version
pnpm exec tauri --version
git status --porcelain
```

Expected: 两条版本号都能打印；`git status --porcelain` 无输出（依赖安装没有改动任何被跟踪文件）。

---

## Task 5: 编译 Rust（最耗时、内存最敏感的一步）

**Files:** Create: `src-tauri/target/`（不提交）

- [x] **Step 1: 限并行编译**

```bash
cd /f/VibeCoding_workspace/Verta/src-tauri
cargo build -j 2
```

Expected 结尾：`Finished \`dev\` profile [unoptimized + debuginfo] target(s) in <N>s`

- `-j 2` 是硬要求：本机空闲内存约 5.5 GB，并行度更高会 OOM。
- 这一步可能要几十分钟（首次全量编译，含 wgpu/naga/wry 等重依赖）。**用后台方式运行，不要设短超时。**
- 若出现 `error[E0463]: can't find crate for ...`：执行 `cargo clean -p <出错的 crate 名>` 后重跑同一条命令。

- [x] **Step 2: 确认产物存在**

```bash
ls -la /f/VibeCoding_workspace/Verta/src-tauri/target/debug/terax.exe
```

Expected: 文件存在且大小非零。

---

## Task 6: 启动应用并截图验收

**Files:**
- Create: `F:\VibeCoding_workspace\Verta\scripts\dev\shot-window.ps1`
- Create: `F:\VibeCoding_workspace\Verta\docs\superpowers\shots\p0-01-window.png`

- [x] **Step 1: 创建截图助手脚本**

`scripts/dev/shot-window.ps1`（改编自 GitShow `scripts/shot.ps1`；用 PrintWindow 抓窗口，不依赖前台焦点）：

```powershell
# 按进程名抓窗口截图，用于逐期验收（PrintWindow，不依赖前台焦点）。
param(
    [string]$ProcName = "terax",
    [string]$Out = "docs\superpowers\shots\p0-01-window.png",
    [int]$WaitMs = 9000
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

$proc = Get-Process -Name $ProcName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
    Select-Object -First 1
if (-not $proc) {
    Write-Error "未找到 $ProcName 的可见窗口"
    exit 1
}

$h = $proc.MainWindowHandle
$r = New-Object Win+RECT
[void][Win]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L
$hh = $r.B - $r.T
Write-Host "窗口 ${w}x${hh}"

$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][Win]::PrintWindow($h, $hdc, 2)   # 2 = PW_RENDERFULLCONTENT，含 GPU 合成内容
$g.ReleaseHdc($hdc)
$g.Dispose()

$outPath = Join-Path (Get-Location) $Out
New-Item -ItemType Directory -Force -Path (Split-Path $outPath) | Out-Null
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "已保存 $outPath"
```

- [x] **Step 2: 启动应用（后台运行，dev 模式）**

```bash
cd /f/VibeCoding_workspace/Verta
pnpm tauri dev
```

Expected: `beforeDevCommand`（`pnpm build:cli:dev && pnpm dev`）起 vite 于 `http://localhost:1420`，随后 `target/debug/terax` 启动；窗口出现（`tauri.conf.json` 里窗口初始 `visible: false`，前端就绪后才显示）。

- [x] **Step 3: 截图**

```bash
cd /f/VibeCoding_workspace/Verta
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev/shot-window.ps1
```

Expected: 打印 `窗口 <w>x<h>` 与 `已保存 ...p0-01-window.png`；用 `read` 工具打开该 PNG 人工确认：窗口标题 `Terax`、能看到终端界面/启动页、没有白屏或错误页。

- [x] **Step 4: 验证"能开一个终端"**

在窗口里点开一个终端标签（人工操作），然后确认 `terax.exe` 确实派生了 shell 子进程：

```bash
powershell -NoProfile -Command "\$p = Get-Process -Name terax | Select-Object -First 1; Get-CimInstance Win32_Process -Filter \"ParentProcessId=\$(\$p.Id)\" | Select-Object Name, CommandLine | Format-List"
```

Expected: 列出 `pwsh.exe` / `powershell.exe` / `cmd.exe`（或 conhost 派生链）之类子进程，证明 pty 正常起进程。

- [x] **Step 5: 留存截图**

P0 验收截图留在本机 `docs/superpowers/shots/`（该目录不进版本库）。

---

## Task 7: 收尾并记录 P0 结果

**Files:**
- Modify: `F:\VibeCoding_workspace\Verta\.superpowers\handoff.md`

- [x] **Step 1: 在交接说明里记录 P0 实况**

在 `.superpowers/handoff.md` 的「基线（对账用）」表后追加一节，写明：P0 完成日期、Verta 首个提交 `Import terax-ai 1a68067 as the Verta baseline` 的 hash、`pnpm install` 与 `cargo build` 的实际结果（含耗时与遇到的报错及处理）、截图路径、以及上游 `1a68067` 与 Verta 基线的对账命令：

```bash
git -C /f/VibeCoding_workspace/Verta diff upstream/main --stat
```

Expected（P0 刚结束时）：无输出。

- [x] **Step 2: 提交收尾改动**

```bash
cd /f/VibeCoding_workspace/Verta
git add -A
git status --short
git commit -m "docs: record P0 baseline results and add window screenshot helper"
```

Expected: 提交成功；`git status --porcelain` 无输出。

---

## 验收标准（P0 完成的定义）

1. `git -C /f/VibeCoding_workspace/Verta diff upstream/main --stat` 无输出（除 Verta 专有文件外，与上游逐字节一致）
2. `git log --oneline` 中基线提交存在，且 `git status --porcelain` 干净
3. `pnpm install --frozen-lockfile` 成功且 `pnpm-lock.yaml` 未被改动
4. `cargo build -j 2` 成功，`src-tauri/target/debug/terax.exe` 存在
5. `pnpm tauri dev` 起得来，界面显示正常（截图在本机 `docs/superpowers/shots/`，不进版本库）
6. 终端标签能开出真实 shell 子进程

---

## 回滚

P0 全部动作集中在 `F:\VibeCoding_workspace\Verta`（P0 前该目录只有 `docs/` 与 `.superpowers/`）。若要完全撤销：

```bash
cd /f/VibeCoding_workspace/Verta
rm -rf .git node_modules src-tauri/target dist
# 再删掉上游复制进来的文件，只保留 .superpowers/ 与 docs/
```

上游 `F:\VibeCoding_workspace\GitProject\terax-ai` **在 P0 中只被读取**，任何步骤都不应改动它；Task 0 / Task 3 Step 2 的两处校验就是为了守住这一点。

---

## 待用户确认（不阻塞 Task 0–7）

1. **是否在 P0 就把 `productName` / `identifier` / `version` 改成 Verta？** 本计划默认**不改**，理由是让基线保持与上游逐字节一致（`diff upstream/main` 为空最好对账）。改名会同时改变 `tauri-plugin-store` 的数据目录（`app.crynta.terax` → 新 id），现在还没数据，改的成本最低，但会打破"零漂移基线"。
2. **`identifier` 若不改，Windows 上会与用户已装的 terax 本体冲突吗？** 若本机已安装 terax 正式版，两者共用同一 identifier 可能导致配置互相覆盖，需要单独确认。

---

## 执行记录（2026-10-17，P0 已完成）

21 个步骤全部执行完毕。结果：

| Task | 结果 |
|---|---|
| 0 基线指纹 | 上游 `1a68067`，工作区干净，1041 个 tracked 文件，与交接说明一致 |
| 1 导入 + init | 复制 1044 个文件（1041 + Verta 专有 3 个），`.git` 重建，`upstream` remote 可用 |
| 2 保真度闸门 | blob 哈希 1041/1041 一致；发现 4 处 mode 漂移并用 `git update-index --chmod=+x` 修复 |
| 3 提交基线 | `1cd3921 Import terax-ai 1a68067 as the Verta baseline`；`git diff upstream/main --stat` 只剩 3 个 Verta 专有文件 |
| 4 装依赖 | `pnpm install --frozen-lockfile` 51.6 秒 / 927 包，`pnpm-lock.yaml` 未改动 |
| 5 编译 | `cargo build -j 2` 11 分 18 秒，无 E0463；`target/debug/terax.exe` 36 MB |
| 6 启动验收 | 窗口起来，日志 `pty opened id=1 cols=135 rows=61`，截图存档 |
| 7 收尾 | 本节 + 交接说明更新 |

### 计划修订（4 处，均已执行）

1. **Task 2 加了一轮修复**：上游 index 里 4 个文件是 `100755`，Windows 上 `git add` 必然写成 `100644`（`git init` 自动设 `core.fileMode=false`）。已复原：`packages/ghostty-core/adapted/ghostty-vt.wasm`、`packages/ghostty-core/ghostty-vt.wasm`、`scripts/app-lab/export-tree.sh`、`scripts/renderer-profile/suite.sh`。
2. **对账方式**：上游 `GitProject\terax-ai` 是 depth-1 浅克隆（只有 1 个 commit），普通 `git fetch upstream` 被拒（`shallow roots are not allowed to be updated`）。新增 `scripts/dev/upstream-drift.sh`，直接比对两个仓库 index 的 mode + blob + 路径，离线可用且能查出 mode 漂移。
3. **`identifier` 改为 `app.verta`**（原计划选择不改，见下方事故）。`productName` 与 `version` 仍保持上游原值。
4. **`shot-window.ps1` 增加 `-ExeMatch` 参数**：原实现只按进程名取第一个带窗口句柄的进程，会抓到你已装的正式版 terax，产出假证据。现按可执行文件路径精确匹配，并在找不到时列出同名进程供排查。

### 事故：identifier 冲突（已修复）

本机装着正式版 terax（`D:\Softwaredata\Terax\terax.exe`，PID 7136），dev 构建沿用 `app.crynta.terax` 导致：

- 我们的 dev 构建读到你真实的 spaces（`cxj work` / `PasteLabel` / `Verta` / `Desktop`）与 AI 会话记录
- 四个 store 文件（`terax-spaces.json` / `terax-ai-sessions.json` / `terax-settings.json` / `.window-state.json`）在 21:17:44 被我们的 app 写过
- 两个 app 共用同一 WebView2 profile（`%LOCALAPPDATA%\app.crynta.terax\EBWebView`），我们的 app 启动约 22 秒后异常退出（无 panic、无报错、无 single-instance 插件）

核对结论：**未发现数据丢失**（2 个 space 的元数据与 state 键一致，标签齐备）。备份在 `~/verta-p0-terax-store-backup-20261017-211927/`。改成 `app.verta` 后两者共存正常，新的数据目录为 `%APPDATA%\app.verta` 与 `%LOCALAPPDATA%\app.verta`。

**这条写进交接说明的原因**：将来 P6 打包、或任何人再跑 dev，都不能回退到 `app.crynta.terax`。

### 遗留

- `KEYRING_SERVICE = "terax-ai"`（`src-tauri/src/modules/secrets.rs`）仍与正式版 terax 共用同一个 OS keychain service。当前 P1 不碰密钥，所以未改；接 AI 能力前必须先处理。
- `%LOCALAPPDATA%\terax\run`（control protocol 的运行目录）也不带 identifier 前缀，两个 app 共享。当前未观察到问题，记此备查。