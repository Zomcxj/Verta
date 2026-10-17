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

## 下一步：P0

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
- **子代理故障**：2026-10-17 当天 testing 子代理连续报 `Variant unavailable for opencode/mimo-v2.6-flash-free: max`，测试派发失败。用户约定测试一律交子代理执行 —— 需要换子代理或等模型侧恢复。
- 首次 `pnpm install` 与 Tauri 构建需要联网。
- 不擅自 `push`；版本号由用户决定（GitShow 曾因子代理擅自升到 0.1.0 被要求回退）。
- 桌面上的 `GitShow.exe` 是拷贝，每次 release 构建后要手动覆盖同步。

## 用户偏好（跨会话有效）

- 界面中文、提交信息英文。
- **不写长段设计说明式注释**（设计进文档，代码只留必要的「为什么」）。
- 不做全量重排式格式化：GitShow 侧不跑 `cargo fmt`；Verta 侧沿用 terax 既有 biome/clippy 配置，也不对上游代码重排。
- 测试交 testing 子代理执行，主助手不直接跑。
- 危险操作（删除、强制推送、重置）先确认。

## 未决事项（spec §11）

1. 会话列表是否做置顶/重命名/隐藏（暂定 P1 只做：打开、复制 resume 命令、复制路径、资源管理器显示）。
2. terax 的 AI 侧栏保留但默认收起是否可接受（暂定：是）。
3. 项目清单与 terax 的 Space 是否同源（暂定：同源，Space 承载项目根 + 新增状态列）。
4. 上游 terax 对账节奏。