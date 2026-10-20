# Changes vs Upstream (Terax AI)

本项目基于 [crynta/terax-ai](https://github.com/crynta/terax-ai)（Apache-2.0）二次开发，该协议要求
修改过的项目说明改动内容，这份文件就是那份说明。按日期倒序，最近的在前。

一条改动写一行，说清楚改了什么，不需要写行号和函数名。新增的、改过的、删掉的都记，
删除整个模块的也记一行，便于日后追溯。

明细按日期折叠：日期本身就是折叠行的标题（`<details>` + `<summary>`），GitHub 上渲染成日期左侧的
展开/收起箭头，纯文本打开也照读。**最新的一天默认 `open`**；换到新的一天时，照抄上一段并把日期换成当天、
上一天的 `open` 去掉即可。

---

<details open>
<summary><strong>2026-10-20</strong></summary>

**GitHub：CI 状态列（远程仓库列表）**

- `src-tauri/src/modules/github/ci.rs`：新增。解析 `repos/{owner}/{repo}/actions/runs?per_page=1` 的最近一次运行；
  以及 `owner/repo` 的预检（空值、`-` 开头、没有斜杠、多段、字符集外的值一律本地拒收，不让它们走到 gh）。
- `src-tauri/src/modules/github/types.rs`：新增 `RepoCiRun` / `RepoCiPayload`，并多一个 `none`：
  「查清楚了没有运行记录」与失败分开，失败绝不伪装成没有 CI。
- `src-tauri/src/modules/github/commands.rs`、`gh.rs`、`mod.rs`、`src-tauri/src/lib.rs`：新增 `github_repo_ci`
  命令（一次一个仓库，30 秒超时），沿用仓库列表那套「没装 gh / 没登录 / 其它失败」的分类与原文透传。
- `src/modules/remotes/RemoteReposView.tsx`：仓库列表加 CI 列。鼠标停到哪一行才查哪一行（不批量查整份列表，
  免得烧掉 API 配额），行菜单里另有「检查 CI」用于强制重查；徽标点开是这次运行的地址。
- `src/modules/remotes/lib/ci.ts`：新增，把 status/conclusion 折成「说什么、什么颜色、点哪里」；带 7 个单测。
- `src/lib/native.ts`、`src/modules/i18n/messages.ts`：命令包装与中英文案。

**Git 面板：分支增删改、worktree、提交级操作**

- `src-tauri/src/modules/git/types.rs`：`MAX_TIMEOUT_SECS` 提到 900 秒，克隆走单独的
  `CLONE_TIMEOUT_SECS`——克隆要从头传完整个历史，120 秒不够。
- `src-tauri/src/modules/git/errors.rs`：新增 `InvalidRefName`；空名字与 `-` 开头的名字在这里被挡掉，
  报错把值加引号显示，空值也看得见。
- `src-tauri/src/modules/git/operations.rs`：新增分支增删改、worktree 增删、拣选、还原、软撤回、
  中止拣选/还原、克隆仓库。名字、修订号、克隆地址先过预检（挡空值与 `-` 开头的参数注入），其余合法性
  交给 git；新建目录的上一级必须先存在，并被登记为已授权（用户手打的路径就是授权依据）。
- `src-tauri/src/modules/git/commands.rs`、`src-tauri/src/lib.rs`：注册对应的十条命令。
- `src/lib/native.ts`：新增这些命令的包装。
- `src/modules/source-control/SourceControlPanel.tsx`：分支行与 worktree 行改成子菜单（切换 / 重命名 /
  删除，打开 / 移除），并加了「新建分支」「新建 worktree」两个入口。
- `src/modules/source-control/BranchDialogs.tsx`：新增五个弹窗。删分支、移除 worktree 都先按普通方式做，
  git 拒绝时把原文留在弹窗里，再给出「强制删除（-D）」「强制移除」。
- `src/modules/git-history/CommitActions.tsx`：新增，提交详情里的拣选 / 还原 / 软撤回。成功先收弹窗再刷新
  （刷新出问题不该让弹窗看起来像失败）；失败把 git 原文留在弹窗里，并允许直接中止卡住的这一步。
- `src/modules/git-history/GitHistoryPane.tsx`：接上这三个动作，操作后重读提交列表。
- `src/modules/i18n/messages.ts`：上面这些界面的中英文文案。

**项目页：克隆仓库**

- `src/modules/projects/CloneRepoDialog.tsx`：新增，填仓库地址与目标目录，克隆完顺手加进项目清单。
- `src/modules/projects/ProjectsView.tsx`：项目页新增「克隆仓库…」入口。

**编辑器：未保存内容备份（编辑中断后内容不丢）**

- `src/modules/editor/lib/drafts.ts`：新增。改动之后把缓冲区镜像进 `verta-drafts.json`：
  单份上限 1 MB、最多 8 份、合计 4 MB，超了丢最旧的；键按路径归一化分隔符但**不**折叠大小写
  （WSL 里只差大小写的两个文件不能被当成一个）。带 11 个单测。
- `src/modules/editor/lib/useDocument.ts`：打字停下 1.5 秒才镜像一次（免得每敲一下过一次 IPC）；
  保存成功或用户选择丢弃时才删草稿；关标签（卸载）、窗口失焦、关窗口都会立刻冲刷一次。
  打开文件时（含崩溃后恢复的标签）若磁盘内容与草稿不同，就把「恢复 / 丢弃」交给界面。
- `src/modules/editor/EditorPane.tsx`：编辑器顶部加一条恢复提示，带上中断时刻；不挡编辑，
  也不自动改文件——恢复只是把内容放回缓冲区，保存与否由用户决定。
- `src/modules/i18n/messages.ts`：这条提示的中英文案。

**测试**

- `src/modules/terminal/ghostty/AdaptedGhosttyGpu.test.ts`：十万次更新的压力用例给 60 秒超时；机器忙起来
  它比默认 5 秒久，这个用例量的是行为不是速度。

**验收脚本**

- `scripts/dev/probes/click-remotes.js`：删除，远程仓库面板的旧探针，用完即弃。

</details>

<details>
<summary><strong>2026-10-19</strong></summary>

**Git 面板：储藏（stash）**

- `src-tauri/src/modules/git/types.rs`：新增 `GitStashEntry`，带上引用、序号、说明与分支。
- `src-tauri/src/modules/git/parser.rs`：新增 `parse_stash_list`，解析 `git stash list` 的
  NUL 分隔输出；说明里解析不出分支时留空，不编造。带三个单测。
- `src-tauri/src/modules/git/operations.rs`：新增 `stash_list`、`stash_push`（可选说明与
  `--include-untracked`）、`stash_apply`、`stash_pop`、`stash_drop`，都走既有的授权与超时封装。
- `src-tauri/src/modules/git/commands.rs`、`src-tauri/src/lib.rs`：注册对应的五条命令。
- `src/lib/native.ts`：新增 `GitStashEntry` 类型与 `gitStashList` / `gitStashPush` /
  `gitStashApply` / `gitStashPop` / `gitStashDrop`。
- `src/modules/source-control/StashSection.tsx`：新增，Git 面板底部的储藏区。默认收起，展开才读；
  可写说明、可选带上未跟踪文件；每条储藏的菜单有应用、应用并删除、丢弃。丢弃要先确认。
- `src/modules/source-control/SourceControlPanel.tsx`：把储藏区接在文件列表下方，操作后刷新面板。
- `src/modules/i18n/messages.ts`：储藏区的中英文文案。

**安装包文案**

- `src-tauri/tauri.conf.json`：`shortDescription` 与 `longDescription` 还是上游文案（写着 AI 原生终端、
  语音输入、AI agent，这些功能都已删除），改成现在的实际定位；NSIS 增加简体中文并打开语言选择，
  此前安装器只有英文。

</details>

<details>
<summary><strong>2026-10-18</strong></summary>

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

</details>

<details>
<summary><strong>2026-10-17</strong></summary>

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

</details>

