# Changes vs Upstream (Terax AI)

本项目基于 [crynta/terax-ai](https://github.com/crynta/terax-ai)（Apache-2.0）二次开发，该协议要求
修改过的项目说明改动内容，这份文件就是那份说明。按日期倒序，最近的在前。

一条改动写一行，说清楚改了什么，不需要写行号和函数名。新增的、改过的、删掉的都记，
删除整个模块的也记一行，便于日后追溯。

---

## 2026-10-18

**应用图标（品牌资源）**

- `assets/icon-stroke.svg`：新增，手绘矢量应用图标（深色圆角底 + 白色 V），替换上游图标。
- `src-tauri/icons/**`：整套平台图标（`.ico`/`.icns`、Windows Store 各档、Android/iOS）由上面的
  矢量图经 `pnpm tauri icon` 重新生成，替换上游 artwork。
- `public/logo.png`：换成同一条矢量的 256px 渲染，页面 head、关于页与终端水印都用它。

**远程仓库面板（新功能）**

- `src-tauri/src/modules/github/**`：新增，一条 `github_repos` 命令，经本机已登录的 `gh` 读取
  账号可访问的仓库（分页、解析、失败分类为纯函数并有单测）。
- `src-tauri/src/modules/proxy.rs`：新增，给外部程序准备代理地址（显式传入 > 环境变量 > 系统
  注册表），并清掉继承的代理变量后注入子进程；`gh` 已用上，git 的 fetch/push/clone 以后可复用。
- `src-tauri/Cargo.toml`：给 `windows-sys` 打开 `Win32_System_Registry` feature。
- `src-tauri/src/modules/mod.rs`、`src-tauri/src/lib.rs`：注册新模块与命令。
- `src/modules/remotes/**`：新增，远程仓库标签页（行映射、筛选、四态提示与单测）。
- `src/lib/native.ts`：新增 `githubRepos` 及线格式类型。
- `src/modules/tabs/**`：新增 `remotes` 标签类型与 `planRemoteReposOpen`，标签栏图标。
- `src/modules/header/Header.tsx`：右上角新增远程仓库入口。
- `src/modules/command-palette/commands.ts`：新增「打开远程仓库列表」一条。
- `src/app/App.tsx`、`src/app/components/WorkspaceSurface.tsx`：接线到中间区域标签页。

**会话恢复环境**

- `src/modules/launcher/lib/openSession.ts`：新增，环境与恢复命令一起算，本机会话不再落到发行版终端。
- `src/modules/launcher/index.ts`、`src/app/App.tsx`：改用上面这个纯函数。

**右侧 Git 面板与项目入口**

- `src/modules/sidebar/**`：侧栏去掉 Git 视图（`SidebarViewId` 只留会话与文件），新增
  `useRightPanel` 管理右侧面板宽度与收起态。
- `src/modules/source-control/**`：面板可见性判断由「侧栏选中 Git」改为「右栏是否展开」。
- `src/modules/header/Header.tsx`：右上角新增右栏开关，并接过改动数徽标。
- `src/modules/projects/**`、`src-tauri/src/modules/projects/**`：项目列表标签页、扫描与状态查询。
- `src/modules/tabs/lib/useTabs.ts`：新增 `projects` 标签类型与 `planProjectsOpen`。
- `src/modules/i18n/messages.ts`：补齐上述界面的中英文文案。

**仓库整理与品牌**

- `LICENSE`：保留上游原文（Apache-2.0），未改动正文；合规所需的版权行见本目录另一处修订。
- 上游 artwork 的本地草稿（根目录的图标 png）与指向上游的 remote 已移除。
- `src-tauri/src/modules/agent_sessions/opencode.rs`、`src/modules/launcher/lib/resumeCommand.test.ts`：
  测试样例换成中性路径与标题，不再引用上游作者的项目目录。
- `scripts/dev/shot-window.ps1`：注释不再点名本机安装的另一个应用。

**功能收缩（自带 agent 移除）**

- `src/modules/ai/**`、`src/modules/agents/**`、`src/components/ai-elements/**`：整个模块删除，
  上游内置的 AI 助手界面、子代理运行器与通知不再存在。终端里的代码块渲染保留。
- `src-tauri/src/modules/agent.rs`、`src-tauri/src/modules/ai_sessions.rs`、
  `src-tauri/src/modules/pty/agent_detect.rs`：随之上游 Rust 侧 agent 会话存储与探测被删除。
- `src/settings/sections/**`、`src/settings/components/**`：与内置 agent、登录启动项相关的设置项被删除。
- `src/modules/editor/**`、`src/modules/markdown/**`、`src/modules/launcher/**`、
  `src/modules/statusbar/**`：删掉引用内置 agent 的分支，其余保留。
- 登录时自动启动（launch at login）选项删除。

**上游元数据**

- `TERAX.md`：更名为 `VERTA.md` 并改写为 Verta 的工程说明（保留上游两个不可改的 wasm 标识说明）。
- `.github/**`（CI、发布、issue 模板、dependabot、CODEOWNERS）、`CLAUDE.md`、`AGENTS.md`：
  上游的项目治理文件随基线清理移除。
- `docs/**`：上游文档全部移除（目录已空，不进版本库）。
- `CODE_OF_CONDUCT.md`：随基线清理移除。
- `CONTRIBUTING.md`、`ROADMAP.md`、`SECURITY.md`：上游的贡献指南、路线图与安全说明不再随仓库
  分发（内容仍描述 Terax 的功能面），文件原样留在本机、由 `.gitignore` 忽略；Verta 自己的工程说明
  在 `VERTA.md`。
- `.coderabbit.yaml`：上游的评审配置不进版本库（`.gitignore` 已忽略）。
- `package.json`：包名改为 `verta`，去掉上游的发布与文档脚本。
- `src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`：产品名、crate 名、应用标识改为 Verta。
- `index.html`、`src/main.tsx`、`vite.config.ts`、`biome.json`：名称与路径引用改为 Verta。
- `.gitignore`：去掉上游的本地草稿与文档忽略项，改为忽略 `.superpowers/`。
- `.gitattributes`：调整换行规则，保证工作树 LF。

**许可证与改动记录**

- `LICENSE`：Apache-2.0 正文保持上游原文；顶部补两行版权，分别是本项目（Zomcxj）与上游 Crynta。
- `README.md`：补版权说明与致谢，指向 Terax AI 并说明差异记录在 `CHANGES.md`。
- `CHANGES.md`：新建，记录本项目与上游的全部差异，按日期倒序。
- `AGENTS.md`：本机的工作约定，说明每次改动都要同步本文件（不进版本库）。
- `README.md`：改写为上游 README 的排版（居中标题、徽章、分节功能表、技术栈、许可），内容换成
  Verta 自己的功能；删去「工作记录」一节，工作区信息归 `AGENTS.md` 管。
- `docs/**`：上游文档与截图从本机删除（目录连同内容），`.gitignore` 里对应的路径规则一并移除。
- 上游遗留文件的清理：`.github/**`（CI、发布流程、issue 模板、dependabot、CODEOWNERS）、
  `.coderabbit.yaml`、`CONTRIBUTING.md`、`ROADMAP.md`、`SECURITY.md`、`flake.nix`、`flake.lock`、
  `nix/`、`scripts/dev/upstream-drift.sh` 从本机删除，`.gitignore` 里对应的死规则一并清掉。

**内置 AI 功能的收尾清理（功能已删，脚手架还在）**

- `src/modules/editor/AiDiffPane.tsx`、`AiDiffStack.tsx`、`AiDiffStackLazy.tsx`：删除，随内置 AI 的
  改动对比界面一起作废。
- `src/modules/tabs/lib/useTabs.ts`：删除 `AiDiffTab` 与 `AiDiffStatus` 类型、`openAiDiffTab`、
  `setAiDiffStatus`、`closeAiDiffTab`（导出了但没有任何调用方）。
- `src/modules/tabs/index.ts`、`src/modules/tabs/lib/tabLabel.ts`、`src/modules/tabs/TabBar.tsx`：
  删掉 `ai-diff` 的转发、标题分支与标签图标。
- `src/modules/editor/useEditorFileSync.ts`：删掉「AI 改动被批准后重载编辑器」的那段监听。
- `src/components/chat-code.tsx`：去掉无人使用的 `ChatStreamingProvider` 导出（文件本身仍用于终端
  与 Markdown 的代码块渲染）。
- `src/app/feature-loading.test.tsx`：去掉对已删组件的加载测试。
- `src/lib/usePresence.ts`：删除，无任何引用的死文件。
- `knip.json`：去掉对已删除的 `src/components/ai-elements/**` 的忽略，以及只给已删脚本用的
  `swiftc` 忽略。

**上游性能与视觉工具的清理**

- `scripts/ipc-profile/`、`scripts/renderer-profile/`、`scripts/pty-smoke/`、`scripts/terminal-visual/`、
  `scripts/ghostty-profile.*`、`scripts/ghostty-soak.*`、`scripts/ghostty-webkit-memory*`：删除，
  连同 `package.json` 里指向它们的脚本（`test:ipc:macos`、`profile:ghostty`、`soak:ghostty`、
  `profile:renderer:*`）。其中 `scripts/ipc-profile/smoke.ts` 引用的正是已删的内置 AI 模块，本来就跑不通。
- 保留 `scripts/dev/**`（本项目的验收工具）、`scripts/build-cli.mjs`、`scripts/dist-graph.*` 与
  `scripts/eager-graph.*`（体积预算测试直接 import 它们）、`scripts/app-lab/**`（`src/bench` 的驱动，
  而 `src/bench` 被 `src/main.tsx` 与 `src/app/App.tsx` 引用）。
- `src/modules/sidebar/useRightPanel.ts`：`shouldPersistRightWidth` 去掉导出（无调用方）。
- `src/app/dist-budget.test.ts`：给那条要跑两次完整构建的用例单独设超时，默认 5 秒在并发下会假红。

**依赖清理（内置 AI 与相关功能删除后留下的空依赖）**

- `package.json`：移除 `ai`、`@ai-sdk/*` 共 9 个包，以及 `zod`、`@radix-ui/react-use-controllable-state`、
  `use-stick-to-bottom`、`@tauri-apps/plugin-autostart`、`@tauri-apps/plugin-notification` 与开发依赖
  `react-compiler-healthcheck`。这些包在源码里没有任何 import，只作为字符串留在体积预算测试的黑名单里。
- `src-tauri/Cargo.toml`、`src-tauri/src/lib.rs`、`src-tauri/capabilities/default.json`：移除
  `tauri-plugin-notification` 的依赖、注册与权限。发通知的代码随内置 AI 模块一起删掉了，插件成了
  只注册不使用的空壳；`@tauri-apps/plugin-autostart` 更是只剩前端包，Rust 侧从未注册。
- `pnpm-lock.yaml`、`src-tauri/Cargo.lock` 随之更新，`node_modules` 里这些包的实体一并清掉。

## 2026-10-17

**会话面板（新功能）**

- `src-tauri/src/modules/agent_sessions/**`：新增，读取本机 opencode（`session_v2`）与 pi（项目内
  jsonl）的真实会话，发行版里的会话在发行版内读取；删除会话经各自 CLI 或文件操作完成。
- `src/modules/launcher/**`：新增，会话列表、恢复命令、子代理过滤、选择与删除的纯函数及界面。
- `src/modules/i18n/**`：新增，中英文界面文案与语言切换。
- `src/app/App.tsx`、`src/modules/sidebar/**`：接线到侧栏，打开即见会话面板。
- `src-tauri/src/lib.rs`、`src-tauri/src/modules/mod.rs`：注册新命令。

**环境跟随**

- `src/modules/workspace/**`：环境改由路径推断（`envForPath`），开终端先备好环境再落地。
- `src-tauri/src/modules/workspace.rs`、`src-tauri/src/modules/pty/**`：按叶子自带环境启动对应 shell。

**基础改造**

- `src-tauri/tauri.conf.json`：应用标识改为 Verta 自己的。
- `.gitattributes`：保证工作树 LF，让前端 lint 门禁在 Windows 上可用。
- `scripts/dev/**`：新增验收用的截图与探针脚本（不参与打包）。
