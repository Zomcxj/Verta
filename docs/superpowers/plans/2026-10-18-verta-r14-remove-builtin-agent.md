# Verta R14（删掉内置智能体）施工计划

- 日期：2026-10-18
- 需求：R14（用户："项目原有的内部智能体不要了"），范围已确认**全删**，含终端钩子
- 规格：设计文档 §12.5

## 0. 关键判断：哪些看起来像 AI 的东西**不能删**

把引用面全部点清之后，有三个文件的处境和名字给人的印象完全不同：

| 文件 | 真实职责 | 判断 |
|---|---|---|
| `src/modules/ai/lib/native.ts`（384 行） | **纯平台 helper**：文件读写、目录、grep/glob、git 状态/日志/diff/分支的 `invoke` 封装与类型。19 个文件在用它，包括 explorer / git-history / source-control / spaces / App | **不能删，要搬家**：移到 `src/lib/native.ts`，只改 import |
| `src/modules/ai/config.ts`（987 行） | 模型目录与 provider 元数据（`PROVIDERS`、`MODELS`、上下文长度、定价、STT/自动补全的默认值） | 跟着 AI 一起删；编辑器设置里用到的那部分要一起摘掉 |
| `src/modules/ai/lib/keyring.ts`（157 行） | 各家 provider 的 API key 读写 | 跟着 AI 一起删；**已存的 key 留在盘上不动**（删代码不等于替你擦密钥） |
| `src/modules/ai/lib/sessions.ts` | AI 聊天记录的落盘（配 Rust `ai_sessions.rs`） | 删；`useAppCloseGuard` 里"关窗前 flush 聊天记录"整段摘掉 |

同理，`src/modules/agents/lib/agentIcon.tsx` 是**我自己写的工具图标**（R3），要搬到 `src/modules/launcher/lib/agent-icon.tsx` 之后才能删 `src/modules/agents`。

## 1. 删除清单

| 目标 | 规模 | 备注 |
|---|---|---|
| `src/modules/ai/**`（除 `lib/native.ts`） | 89 文件 / 14.7k 行 | 侧栏、聊天、工具面板、store、模型设置界面 |
| `src/components/ai-elements/**` | 11 文件 / 2.7k 行 | 聊天 UI 基元。**例外**：`markdown-code.tsx` 被 `modules/markdown/MarkdownPreviewPane.tsx` 用，搬到 `src/components/markdown-code.tsx` |
| `src/modules/agents/**` | 27 文件 / 2.4k 行 | 通知铃、agent 启动器、审核、声音。例外：`lib/agentIcon.tsx` 先搬走 |
| `src-tauri/src/modules/ai_sessions.rs` | 1243 行 | 连同 `SessionFilesState` 的 `manage` 与 5 个命令 |
| `src-tauri/src/modules/agent.rs` | 567 行 | 连同 `agent_enable_hooks`、`agent_hooks_status`、`emit_conout_marker` 的调用点 |

## 2. 顺序（每步都要能编译、能跑测试）

1. **搬 `native.ts` → `src/lib/native.ts`**，机械替换 19 个 import，跑 `check-types` + 全量测试。这一步不动任何行为。

   **踩到的坑（务必照做）**：一次搬迁要改**三类**引用，少一类就会出事：
   - 外部文件的 `@/modules/ai/lib/native`（18 个文件）
   - **`ai/` 内部自己的相对引用** `../lib/native`、`./native`（7 个文件）。只查 `@/` 会漏掉，`check-types` 会报 `Cannot find module`
   - **测试里的 `vi.mock("../lib/native", ...)`**（`edit` / `search` / `shell` 三个测试）。这条最隐蔽：类型检查完全通过，但 mock 接不上真实模块，测试会跑真实实现并失败（本机 10 个用例失败）。统一改成 `vi.mock("@/lib/native", ...)`
2. **搬 `agentIcon.tsx` → `launcher/lib/`**，改 1 个使用点（`SessionList`），跑测试。
3. **搬 `markdown-code.tsx` → `src/components/`**，改 `MarkdownPreviewPane` 的 import，跑测试。
4. **摘 Rust**：删 `ai_sessions.rs`、`agent.rs`，去掉 `mod`、`manage`、命令注册、`emit_conout_marker` 调用；`cargo clippy -D warnings` + 全量 Rust 测试。
5. **摘前端连线**（按文件，每改完一批就 `check-types`）：
   - `App.tsx`：`AiComposerProvider`、`panelOpen`/`useChatStore`、AI diff 审批回调、`agent_enable_hooks` 调用、`nextAttentionTarget`
   - `Header.tsx`：`NotificationBell`
   - `WorkspaceInputBar.tsx`：`Chip`/`ChipsRow`/`useComposer`，以及 composer 相关的 props
   - `StatusBar.tsx`：`AgentStatusPill`、`AiStatusBarControls`、`AiOpenButton`
   - `useAppCloseGuard.ts`：`flushPersist`/`flushSessionWrites` 与"关窗前 flush"整段
   - `settings/`：`AgentsSection`、`ModelsSection`、`ProviderKeyCard`、`ProviderIcon` 与对应的 store 字段
   - `source-control/useSourceControlPanel.ts`：`useChatStore` 与模型相关判断
   - `terminal/block/BlockOverlay.tsx`：`useChatStore`
   - `editor/EditorPane.tsx`、`editor/lib/autocomplete/provider.ts`：AI 补全（用户选了全删）
6. **删目录**：`src/modules/ai`（剩下的）、`src/components/ai-elements`、`src/modules/agents`。
7. **收尾**：三个预算测试的断言方向已核实，都是"上限/禁入"语义（`violations` 是"不该被预加载的 chunk 与包"，`trace.missing` 只记 HTML 声明了但产物缺失的 chunk），删掉 AI 只会让它们更容易通过，不会因"变小"而失败。`compositingBudget` 的 `files.length > 100` 与 `dist-budget` 的 `files.size > 5` 也不受影响。仍需跑一遍确认。
8. **记录**：把这次删除写进 `.superpowers/handoff.md` 的"与上游分歧"表（注明"这个 fork 不含内置智能体"），并更新需求台账 R14 状态。

## 3. 不做的事

- **不擦你已存的 API key**（`tauri-plugin-store` 里的模型密钥原样保留）。
- **不删已写的 AI 聊天记录文件**（`ai_sessions.rs` 管的那些），只停止读写它们的代码。
- 不顺手翻译上游英文界面文案（属于单独一轮）。

## 4. 风险

| 风险 | 处理 |
|---|---|
| `App.tsx` 是 1600+ 行的大文件，连线多 | 每摘一块就 `check-types`，一次只动一类引用 |
| 设置里删掉模型/AI 项后，`settings/store.ts` 的默认值结构变化 | 只删 AI 专属字段；不确定的字段先标 `@deprecated` 留一轮，下轮再删 |
| 预算测试可能断言"不低于某值" | 先读断言方向，若是下限则改成上限语义 |
| 用户可能日后想要回 AI 侧栏 | 上游 `1a68067` 是完整来源，`git revert` 这一提交即可恢复；提交信息里写明这一点 |
