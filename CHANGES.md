# Changes vs Upstream (Terax AI)

本项目基于 [crynta/terax-ai](https://github.com/crynta/terax-ai)（Apache-2.0）二次开发，该协议要求
修改过的项目说明改动内容，这份文件就是那份说明。按日期倒序，最近的在前。

一条改动写一行：**上游没有的新模块 / 新功能**写一行就够；**改到上游原有文件的**要具体到文件
（哪个文件、改了什么）。不写行号与函数名。

明细按日期折叠：日期本身就是折叠行的标题（`<details>` + `<summary>`），GitHub 上渲染成日期左侧的
展开/收起箭头，纯文本打开也照读。**最新的一天默认 `open`**；换到新的一天时，照抄上一段并把日期换成当天、
上一天的 `open` 去掉即可。

---

<details open>
<summary><strong>2026-10-22</strong></summary>

**Issues / PR：合并前锁住 head sha、检查超过 100 条会翻页、列表几个小毛病**

- `src-tauri/src/modules/github/commands.rs`：合并 PR 带上确认框打开时那条 PR 的 head sha（`sha` 字段）—— 你点确认到请求落地之间别人又推了提交的话，GitHub 回 409，我们把原文透出来，不会把没看过的提交一起合掉；`check-runs` 超过 100 条时按页取（最多 10 页），取完再一起数。
- `src-tauri/src/modules/github/issues.rs`：新增 `head_sha_problem`（空的允许，给了值必须是 40 位十六进制）、`summarize_check_pages`（多页合并后只算一次状态，少拿仍是 `partial`）、`checks_page_path` / `checks_have_more` / `count_check_runs`。
- `src/lib/native.ts`、`src/modules/remotes/IssuesDialog.tsx`：合并时把 head sha 从详情带进去；列表请求加序号，切「打开 / 已关闭」时慢响应不会盖掉新结果；空态按当前筛选说人话（「只看打开的」「只看已关闭的」「哪里都没有」）。
- `src/modules/remotes/lib/issues.ts`：关键字里带 `#` 也能按编号搜（`#20` 与 `20` 等价）。
- `src/modules/command-palette/commands.ts`、`src/modules/command-palette/types.ts`、`src/modules/i18n/messages.ts`：命令面板里禁用原因原来写死英文（`Last tab` / `Pane limit` / `No workspace root`），改成 i18n 键，中文界面不再蹦英文。

**GitHub 面板：检查状态不再「假绿」，合并被拦的理由不再写死中文**

- `src-tauri/src/modules/github/commands.rs`：取 `check-runs` 时显式带 `per_page=100`（GitHub 默认一页只有
  30 条）。一页 40 个检查只看到前 30 个，界面就会把「没看完」当成「全通过」。
- `src-tauri/src/modules/github/issues.rs`：`parse_checks` 记下 `truncated`（拿到的条数少于 `total_count`）；
  `check_state` 多一个 `partial` —— **只看到一部分、而被看到的那部分又全绿时不再报 `pass`**（看到失败、
  或还有在跑的，照旧优先报 `fail` / `pending`）。`merge_block_reason` 改名 `merge_block_code`，不再返回
  中文句子，改返回原因码（`merged` / `closed` / `draft` / `conflict` / `computing` / `unknown`）。
- `src-tauri/src/modules/github/types.rs`：`CheckSummary` 增 `truncated`；`merge_blocked_reason` 改名
  `merge_blocked`（内容是原因码，不再是可以直接画上屏幕的句子）。
- `src/lib/native.ts`、`src/modules/remotes/lib/issues.ts`：wire 与映射跟上；`mergeBlocked()` 直通原因码，
  `checkTone` 接受 `partial`（给中性色，不给绿）。
- `src/modules/remotes/IssueDetail.tsx`：合并被拦的那句话从「后端中文串直出」改成按码走 i18n。
- `src/modules/i18n/messages.ts`：新增 `remotes.issues.checks.partial` 与 `remotes.issues.mergeBlocked.*`
  六条键（中英两份）。

</details>

<details>
<summary><strong>2026-10-21</strong></summary>

**标签页：去掉「空间」（Spaces），只留一份标签列表**

- `src/modules/spaces/**`（14 个文件）、`src/modules/i18n/spaceName.ts`：整个模块删掉。空间（名字、根目录、
  环境、配色、各自的标签持久化、`SpaceSwitcher`）和项目列表是同一件事的两种说法，还让每个标签都要带一个
  空间 id。`src/modules/spaces/lib/serialize.ts` 与 `activeSpace.ts` 里真正有用的两件事搬到了别处（见下）。
- `src/modules/tabs/lib/useTabs.ts`：`Tab.spaceId`、`DEFAULT_SPACE_ID`、按空间去重的各类 `plan*`
  （打开文件 / markdown / git diff / 提交历史 / 项目列表 / 远程仓库）、空间删除、跨空间移动一起删掉；
  去重、关闭、拖拽排序现在都作用在同一条列表上。**「最后一个标签拒绝关闭」的语义保留**
  （`nextActiveInSpace` 因此改名 `nextActiveTab`），私有标签不落盘也一样。
- `src/modules/tabs/lib/serialize.ts`（从 spaces 模块搬来，去掉 `spaceId`）、新增 `tabStorage.ts` 与
  `useTabRestore.ts`：标签列表改存 `verta-tabs.json` 里的单个 `state` 键。改用新格式后第一次启动，会从老文件
  `verta-spaces.json` 里把当时活动空间那份 `state:<空间 id>` 读出来、写进新文件、删掉那条键，老文件留在磁盘上；
  恢复仍然要求标签各自回到自己的环境（叶子记着环境，只记了 cwd 的按路径反推），并且 cwd 先授权再开终端。
  `usePreferencesStore.init()` 依旧只在这一处调用，写盘也依旧等恢复完成才开闸。
- `src/app/App.tsx`：空间状态、`SpaceSwitcher`、只喂给它的六个 handler、三个空间快捷键、命令面板里的
  五条空间命令、「单击项目行 = 切换到以该项目为根的空间」全部去掉。项目行现在只做一件事：切到该项目的
  环境（本机 / 发行版），在项目根目录开一个终端。
- `src/modules/header/Header.tsx`：标题栏给切换器留的槽位删掉。
- `src/modules/source-control/repositoryTarget.ts`、`useRepositoryTargeting.ts`：右栏钉住的仓库按**环境**
  （本机 / 某个发行版）而不是按空间分开记。
- `src/modules/control/lib/context.ts`、`useControlBridge.ts`：`space_id` 保留但固定为 `default`——
  `verta-cli identify` 会打印它，删掉等于改协议。
- `src/modules/i18n/messages.ts`：中英两份里的 14 个空间键（`spaces.*`、`shortcut.nextSpace` /
  `prevSpace` / `openSpaces`、`cmd.spacesOverview` / `newSpace` / `switchToSpace` / `currentSpace`、
  `cmdGroup.Spaces`、`shortcutGroup.Spaces`）删除。
- `src/modules/shortcuts/shortcuts.ts`、`src/modules/command-palette/commands.ts`、`types.ts`、
  `CommandPalette.tsx`：空间快捷键组、空间命令、`spaceName` 一并清掉。

**区域截图：像系统自带那样不冻屏，框完点保存才抓**

- `src-tauri/src/modules/screenshot/mod.rs`：改成**不冻屏**。屏幕在框选期间一直是活的（覆盖窗口是透明的，
  只压一层浅灰），抓屏挪到**点保存那一刻**：先把覆盖窗口藏起来、等它真的从屏幕上消失（`hide()` 只是把请求
  交给系统，屏幕上那一帧还留着）再抓，否则灰层、选择框、把手、操作条会一起进到图里；整段放在阻塞线程上做。
  窗口仍然**建一次就养着**（每次只是把它亮出来：第一次要建 webview 约 0.4 秒，之后 0.1 秒出头）；
  失败时把窗口亮回来，选区还在，能接着调、接着存。
- `src-tauri/src/modules/screenshot/capture.rs`：新增 `virtual_screen_bounds()`——抓屏与覆盖窗口的铺法从同一
  处取范围，选区坐标才对得上。`RawShot` 不再带 origin（覆盖窗口的位置同样来自这一处）。
- `src-tauri/src/modules/screenshot/encode.rs`：删掉 BMP 预览编码器（不再有预览文件），只留存盘那份 PNG。
- `src/modules/screenshot/ScreenshotOverlay.tsx`：**去掉画布与冻结画面**。整屏压一层 25% 的浅灰；一画出选区
  就撤掉这层、改由选区一圈阴影压暗框外——框里是全透明的洞，透出来的是活着的那块屏幕（这也是「像系统自带」
  的关键：不冻屏，屏幕该动就动）。圆角滑杆（0–40，默认 **15**，所见即所得）、保存 / 取消两个图标按钮放在
  选区右下角；描边、把手、按钮都取主题色。松手之后选区留着可继续调整：拖整块、八个把手改大小。
  Enter 保存、Esc 取消，都没变。
- `screenshot.html`、`src/screenshot/main.tsx`：这个窗口**必须透明**——这两处按窗口的性质把底色铺成透明
  （globals.css 给 body 铺了主题底色），并补上 `.light` / `.dark` 类（`--primary` 那些变量在根节点上没有
  这个类就取不到，描边会退成灰白）。另外：窗口自己的脚本崩了就调 `screenshot_failed` 把自己收起来，
  别在用户面前杵着一层点不动的灰。
- `src/lib/native.ts`、`src/modules/i18n/messages.ts`：`screenshot_begin` 不再返回抓屏结果；删掉
  `screenshot_pending` / `screenshot_pixels`（预览文件、IPC 整块传像素这两条路都不需要了）；收尾文案改成
  正式口气（不再有「也在剪贴板里了」这类说法，Rust 侧的错误串一并改）。
- `src-tauri/capabilities/screenshot.json`：显示与聚焦现在由 Rust 侧做，覆盖窗口的权限缩到「只听事件」。
- `scripts/dev/probes/`：验收探针跟着改——`screenshot-arm-timing-*`（量「收到消息到首帧」）、
  `capture-desktop.ps1`（拍整屏取证；`CopyFromScreen` 与窗口自己的 CDP 截图看的不是同一件事）、
  `screenshot-begin-timing.js`（只量「点一下到灰层上来」）。

**区域截图：抓屏、框选、存图、进剪贴板都在应用里**

- `src-tauri/src/modules/screenshot/`（新增一个模块，四个文件）：
  - `capture.rs`：Windows 用 GDI 抓整块虚拟桌面。GDI 给的是 BGRA、alpha 是垃圾值，顺手补成不透明
    RGBA —— 不补的话存出来的 PNG 与剪贴板里的图都是半透明的；别的平台如实拒绝，不假装能跑。
  - `geom.rs`：选区收边（往回拖、拖出画面都算对）、按选区抠图、文件名与本地时间戳。全是纯函数带单测。
  - `encode.rs`：PNG 编码，用依赖树里本来就有的 `image`，只开 `png` 一个 feature。
  - `mod.rs`：截图状态与命令（`begin` 把覆盖窗口亮出来 / `finish` 藏窗口、抓屏、裁剪、落盘、进剪贴板 /
    `cancel` / `failed`）。裁剪用的是抓下来的原始像素：把整屏喂给 asset 协议再让 canvas 裁会被跨源
    污染，`toBlob` 直接抛。裁剪在后端、选区在前端，所以选区在后端还要再收一次边。
- `src-tauri/src/modules/mod.rs`、`src-tauri/src/lib.rs`、`src-tauri/Cargo.toml`：注册模块、状态与命令；
  windows-sys 补 `Win32_UI_WindowsAndMessaging`（要 `GetSystemMetrics` 与虚拟屏幕常量）。
- `src-tauri/capabilities/screenshot.json`（新增）：覆盖窗口单独一份**最小**权限——只听事件，显示与聚焦
  由 Rust 侧做，也不给 store / dialog / opener 那些它用不着的。
- `screenshot.html`、`src/screenshot/main.tsx`、`vite.config.ts`：第二个窗口的前端入口（透明窗口），
  多页构建多一份。
- `src/modules/screenshot/ScreenshotOverlay.tsx`（新增）：铺一层浅灰、拖框（带物理像素尺寸提示）、
  松手后可挪可拉、圆角滑杆、保存 / 取消图标按钮，Enter 保存、Esc 取消；不冻屏——屏幕一直是活的。
- `src/modules/screenshot/lib/selection.ts`（新增）：CSS 像素 ↔ 物理像素换算——屏幕缩放到 125% 时两者差
  一个 devicePixelRatio，直接送 CSS 坐标会切偏；取整是「宁可多含一列，不少给一列」。带单测。
- `src/modules/header/Header.tsx`：右上角 Git 按钮左边多一个「截图」。
- `src/app/App.tsx`、`src/lib/native.ts`、`src/modules/i18n/messages.ts`：收尾提示条（写明存到哪儿、
  剪贴板成没成，两件事分开报）与「插入路径」——点了才把路径插进当前终端输入行（走括起的粘贴，
  路径里有空格也不怕），不自动插、不回车；不在终端页时干脆不给这个按钮（点了也没处插）。
- `scripts/dev/cdp-input.mjs`（新增）+ `scripts/dev/probes/`（截图这一块的探针与 `capture-desktop.ps1`）：
  往**指定**窗口发真实输入与验收取证。`cdp-key.mjs` 只会找第一个 page，而覆盖窗口是第二个，鼠标拖拽也需要
  一次完整的 press/move/release（DOM 里合成 PointerEvent 顶不了：`setPointerCapture` 只认真指针）。

**Pi 会话列表：显示最新的会话名**

- `src-tauri/src/modules/agent_sessions/pi.rs`：会话名不再只从文件头 8 MB 里找（长会话里改名那行可能在几十 MB 之后，读不到就退回第一条用户消息）；改成从文件末尾按块往回搜 `session_info`，取最后一个名字，命中处把那一整行读全。头部窗口从 8 MB 降到 1 MB。

**Markdown 预览：没写尺寸的小图不再被撑成大横幅**

- `src/modules/markdown/MarkdownImage.tsx`：没写高度的图片原来一律钉成 `height: 260px`（配 `object-fit: contain`），116×20 的徽章被拉成整栏宽的大横幅；改成加载前按 260px 占位、加载完回到图片自己的尺寸（260px 只当封顶）。尺寸决策抽成纯函数 `previewImageStyle`。
- `src/modules/markdown/MarkdownImage.test.ts`：新增，覆盖四个分支。

**Markdown 预览：并排的小图回到一行**

- `src/modules/markdown/MarkdownImage.tsx`：图片 `display` 从 `block` 改成 `inline-block`（配 `mr-2 last:mr-0`），一行里的几张图并排显示、中间留间距。

**字体：改成下拉选本机字体（终端与编辑器共用一个字体）**

- `src-tauri/src/modules/fonts.rs`：新增，列本机字体族（Windows GDI `EnumFontFamiliesExW` / Linux `fc-list` / macOS `system_profiler`）；新增命令 `fonts_list`。
- `src/lib/fontOptions.ts`、`src/settings/components/FontPicker.tsx`、`src/settings/lib/useInstalledFonts.ts`：新增，选项是「自动检测」+ 本机字体（当前值不在本机时也列出来并标注），下拉可搜索。
- `src/settings/sections/GeneralSection.tsx`、`src/modules/i18n/messages.ts`：字体那一栏改成下拉，说明写明终端与编辑器共用。
- `src/modules/settings/store.ts`：`terminalFontFamily` 默认值由空改成 `Cascadia Code`（已经存过的值不动）。
- `src/lib/fonts.ts`：终端字体栈「选中的字体 → 自动检测到的 Nerd Font（图标）→ 兜底链」。
- `src/modules/editor/lib/useApplyEditorFontFamily.ts`、`src/modules/editor/lib/extensions.ts`：编辑器字体走 `--editor-font-family` 变量。
- `src-tauri/Cargo.toml`：`windows-sys` 加 `Win32_Graphics_Gdi` feature。

**GitHub：账号与登录**

- `src-tauri/src/modules/github/auth.rs`：新增。解析 `gh auth status --json hosts`（挑活跃账号、拆 scopes、缺字段不崩），以及在本地拦掉明显不对的粘贴 token。
- `src-tauri/src/modules/github/gh.rs`：抽出 `command()`（参数一条条传、关交互提示、套代理、隐藏控制台统一备好）；新增 `spawn` / `pump` / `run_with_stdin`（粘 PAT 只能从 stdin 进）；新增 `AUTH_TOKEN_TIMEOUT_SECS` / `AUTH_WEB_TIMEOUT_SECS`。
- `src-tauri/src/modules/github/types.rs`：新增 `AuthStatusPayload` / `AuthActionPayload` / `AuthLoginProgress`。
- `src-tauri/src/modules/github/commands.rs`、`mod.rs`、`src-tauri/src/lib.rs`：新增 `github_auth_status` / `github_auth_login_token` / `github_auth_login_web`（把 gh 打的一次性码实时推给界面，可中止）/ `github_auth_login_web_cancel` / `github_auth_logout`，以及 `AuthLoginState`。
- `src/lib/native.ts`：新增上述五条包装与线格式类型。
- `src/modules/remotes/lib/auth.ts`：新增。登录态折成界面要的样子、缺 `delete_repo` 授权的判定、粘 token 的本地预检。
- `src/modules/remotes/AuthDialog.tsx`：新增。当前状态 / 浏览器授权（实时输出一次性码、可中止）/ 粘贴 PAT（提交后立刻清空输入框）/ 登出（确认框先说清后果）。
- `src/modules/remotes/RemoteReposView.tsx`：页头账号变成入口；没登录 / 没装 gh 的提示块里也加一个入口；关掉面板时重读一次列表。
- `src/modules/i18n/messages.ts`：新增上述界面的中英文文案。
- `scripts/dev/probes/auth-acceptance.mjs`：新增，登录态面板的验收脚本（`--isolated` 那轮在临时 `GH_CONFIG_DIR` 里跑「没登录」的流程，不碰真实登录态）。

**GitHub：仓库管理（改描述 / 切可见性 / 删仓库）与克隆到本地**

- `src-tauri/src/modules/github/repo_admin.rs`：新增。读 `gh repo view --json description,visibility,viewerPermission`；描述超 350 字在本地拦下；认出「gh 缺 delete_repo 授权」这种能自己补救的失败。
- `src-tauri/src/modules/github/permission.rs`：新增 `admin_allowed`（只有 `ADMIN` 算管理员；查不到 / 不认识的档位按能改算）。
- `src-tauri/src/modules/github/types.rs`：新增 `RepoSettingsPayload`（失败时 `can_admin` 仍是 true）与 `RepoActionResult`。
- `src-tauri/src/modules/github/commands.rs`、`gh.rs`、`mod.rs`、`src-tauri/src/lib.rs`：新增 `github_repo_settings` / `github_repo_set_description` / `github_repo_set_visibility` / `github_repo_delete`（60 秒超时；删除发完请求回查 `gh api repos/{slug}` 拿到 404 才算成功；缺 delete_repo 授权时把该跑的命令写进报错原文）。
- `src/lib/native.ts`：新增 `githubRepoSettings` / `githubRepoSetDescription` / `githubRepoSetVisibility` / `githubRepoDelete` 与线格式类型。
- `src/modules/remotes/lib/repoAdmin.ts`：新增。`canAdmin`（没查出来 / 查不动都按能改）、只读提示键、`isPrivateVisibility`、删仓库的「手输全名」判定、描述长度、克隆目标目录的相邻推算。
- `src/modules/remotes/RepoAdminDialog.tsx`：新增。描述保存、可见性切换（切公开 / 切私有各自的后果确认）与危险区（手输仓库全名才给删除按钮，删完回传让列表拿掉那一行）；非管理员时三类入口都不渲染。
- `src/modules/remotes/RemoteReposView.tsx`：行菜单新增「克隆到本地…」与「仓库设置…」；描述 / 可见性改成功后只更新那一行；接上克隆与设置两个弹窗。另修：菜单内容是 Radix 传送到 body 的，但 React 事件仍沿组件树冒泡，点菜单项会连带触发整行点击（于是「仓库设置…」会顺手把运行记录面板也开出来）—— 在菜单内容上拦掉。
- `src/modules/remotes/RunListDialog.tsx`：修：确认框（AlertDialog）是另一个 Radix 层，点它会被上层当成「点到面板外面」而把面板一起关掉；确认框开着时不再关。
- `src/modules/projects/CloneRepoDialog.tsx`：新增可选的地址与目标目录预填（从远程仓库那一行进来时用）。
- `src/modules/i18n/messages.ts`：新增上述界面的中英文文案。
- `scripts/dev/probes/repo-admin-acceptance.mjs`：新增，仓库管理与克隆的验收脚本。

**GitHub：权限门禁**

- `src-tauri/src/modules/github/permission.rs`：新增。读 `gh repo view --json viewerPermission`，`TRIAGE` / `READ` 判成不可写；查不到或不认识的档位按可写算（按钮照样给，让 GitHub 去拒绝）。
- `src-tauri/src/modules/github/types.rs`：新增 `RepoPermissionPayload`；失败时 `can_write` 仍是 true。
- `src-tauri/src/modules/github/commands.rs`、`gh.rs`、`mod.rs`、`src-tauri/src/lib.rs`：新增 `github_repo_permission` 命令（30 秒超时）与注册。
- `src/lib/native.ts`：新增 `githubRepoPermission` 与 `WireRepoPermissionPayload`。
- `src/modules/remotes/lib/permission.ts`：新增。`canWrite`（没查出来 / 查不动都按可写）与只读提示键。
- `src/modules/remotes/RunListDialog.tsx`：打开时查一次该仓库权限；不可写时不渲染重跑 / 取消 / 删除，并加一句只读提示。
- `src/modules/i18n/messages.ts`：新增只读提示的中英文文案。
- `scripts/dev/probes/permission-acceptance.mjs`：新增，权限门禁的验收脚本。

**GitHub：Releases 与附件下载**

- `src-tauri/src/modules/github/releases.rs`：新增。解析 Release 列表、附件名落盘预检、进度合并阈值、`<name>.verta-part` 成功才改名（失败只删临时文件），以及按 id 的取消标记。
- `src-tauri/src/modules/github/types.rs`：新增 `RepoRelease` / `RepoReleaseAsset` / `RepoReleasesPayload` / `ReleaseDownloadProgress` / `ReleaseDownloadResult`。
- `src-tauri/src/modules/github/commands.rs`：新增 `github_releases`；新增 `github_release_download`（流式读 gh 输出，45 秒停滞 / 30 分钟总超时，实收字节与附件大小不符判失败，进度经 `verta://github-download` 发出）与 `github_release_download_cancel`。
- `src-tauri/src/modules/github/mod.rs`、`src-tauri/src/lib.rs`：注册新模块、三条命令与 `DownloadState`。
- `src-tauri/Cargo.toml`、`src-tauri/capabilities/default.json`、`package.json`、`pnpm-lock.yaml`、`src-tauri/Cargo.lock`：新增 `tauri-plugin-dialog` 与 `@tauri-apps/plugin-dialog`，权限只给 `dialog:allow-open`。
- `src/lib/native.ts`：新增 `githubReleases` / `githubReleaseDownload` / `githubReleaseDownloadCancel` 与线格式类型。
- `src/modules/remotes/lib/releases.ts`：新增。列表映射、大小与速度文案、百分比、进度平滑。
- `src/modules/remotes/lib/pickDownloadDir.ts`：新增。目录选择，默认系统下载夹，取不到退回主目录。
- `src/modules/remotes/ReleasesDialog.tsx`：新增。列表 → 详情，进度事件按下载 id 认领。
- `src/modules/remotes/ReleaseDetail.tsx`：新增。附件行下载 / 进度 / 速度 / 取消 / 打开所在文件夹，正文用按需加载的 Markdown 渲染。
- `src/modules/remotes/RemoteReposView.tsx`：行菜单新增「Releases…」。
- `src/modules/i18n/messages.ts`：新增上述界面的中英文文案。
- `README.md`：功能表补 Releases 与附件下载。
- `scripts/dev/probes/releases-acceptance.mjs`：新增，Releases 与附件下载的验收脚本。

**文档对账**

- `VERTA.md`：删掉已不存在的内置智能体章节；模块清单补 `launcher` / `projects` / `remotes` / `i18n`，Rust 命令清单补 `agent_sessions` / `projects` / `github`；标签种类补 `projects` / `remotes`；Git 面板改记右栏、侧栏只留会话与文件；删掉已移除性能脚本的引用；补未保存草稿备份、终端会话图片、Markdown 图片尺寸与 Releases 下载；门禁命令改为 `cargo test --lib`；删掉两处与代码不符的说法（图片鉴权、secret deny-list）。

</details>

<details>
<summary><strong>2026-10-20</strong></summary>

**GitHub：CI 徽标跟运行面板走，去掉重复的入口**

- `src/modules/remotes/lib/runs.ts`：新增 `ciFromRuns`（把运行列表折成那一行 CI 徽标该显示的东西：
  最新那条就是徽标；列表空了就是查清楚的「没有运行记录」；查不动就原样透传）；带单测。行菜单里那句
  「检查 CI」和「运行记录…」本来就是一个事实的两种说法——徽标按行缓存，删掉旧运行之后它可能还挂着
  旧结论，与面板自相矛盾。现在面板是唯一来源。
- `src/modules/remotes/RunListDialog.tsx`：新增 `onLoaded`，每次读到运行列表（含删除后的重新对账）
  回传一次。
- `src/modules/remotes/RemoteReposView.tsx`：接上 `onLoaded`，面板一读完就用它最新那条更新该行徽标；
  行菜单里重复的「检查 CI」删除（悬停自动查、徽标没结果时点它现查这两条仍在）。

**GitHub：删除运行记录；点击不再跳浏览器**

- `src-tauri/src/modules/github/commands.rs`、`src-tauri/src/lib.rs`：`RunAction` 多一个 `Delete`，新增
  `github_run_delete`（`gh run delete <id> --repo <slug>`）。重跑 / 取消 / 删除共用同一条通道，预检、
  失败分类、原文透传都一样。**删除后回查一次那条运行还在不在**（`repos/{o}/{r}/actions/runs/{id}`）：
  只有明确 404 才报成功，还在就如实说「可能没删掉」，说不清（限流 / 代理抽风 / 权限）把原因带出去——
  光看 `gh run delete` 的退出码不够，那条路上任何一环骗我们一次，界面就会把一条其实还在 GitHub 上的
  记录永久藏起来（行被拿掉、刷新又被滤掉）。
- `src-tauri/src/modules/github/actions.rs`：新增 `classify_run_probe`（回查结论：没了 / 还在 / 说不清）
  与 `RunProbe`，带单测。
- `src/modules/remotes/RunListDialog.tsx`：行内新增「删除」，只在跑完了的运行上给（GitHub 不允许删
  正在跑的那条）；二次确认写明「日志与结果一起删掉、不可恢复」，失败把 gh 原话留在确认框里。删除
  **经后端回查确认**后，界面立刻拿掉那一行，再在后台刷新对账——之前是先弹浮层、再等两三秒的刷新，
  浮层与面板短暂对不上，用户当场看到了；刚删掉的 id 也记下来、刷新时滤掉，免得 GitHub 慢一拍又把
  行弹回来（只滤「已确认删掉」的那些，失败的一律留在列表里）。
- `src/modules/remotes/RemoteReposView.tsx`：仓库行点击与 CI 徽标点击都改成在软件内打开该仓库的运行面板
  （「在浏览器打开」只留在行菜单里）。到此，GitHub 面板里所有「点一下就跳浏览器」的路都没了。
- `src/modules/remotes/lib/runs.ts`：新增 `canDelete`（跑完了才能删）与 `withoutRun`（按 id 拿掉一行）；带单测。

**GitHub：运行详情在软件内（job / step / 日志）**

- `src-tauri/src/modules/github/actions.rs`：新增 `parse_jobs`（读 `actions/runs/{id}/jobs`，含步骤树）、
  `parse_log`（拆 `job\tstep\t<时间> 正文` 三段；认不出前缀的行原样留着，绝不丢行；第一行时间戳前的 BOM
  剥掉）、`cap_lines`（日志只留最后 `MAX_LOG_LINES = 2000` 行）。带 7 个单测。
- `src-tauri/src/modules/github/types.rs`：新增 `RepoRunJob` / `RepoRunStep` / `RepoRunJobsPayload` /
  `RepoRunLogLine` / `RepoRunLogPayload`。日志的两种截断分开报：`clipped`（我们只留了尾部）与 `capped`
  （撞上一次能取的上限、拿到的是开头），界面上说法不同。
- `src-tauri/src/modules/github/gh.rs`：`GhOutput` 带上 `stdout_truncated`，并从 `run` 里拆出
  `run_with_cap`；日志单独给 90 秒与 8 MB 的上限（`LOG_TIMEOUT_SECS` / `LOG_STDOUT_CAP`）。
- `src-tauri/src/modules/github/commands.rs`、`src-tauri/src/lib.rs`：新增 `github_run_jobs` 与
  `github_run_log`（`failed_only` 走 `gh run view --log-failed`）。
- `src/modules/remotes/RunDetail.tsx`：新增。软件内的运行详情：job 与步骤树（每步一个状态）、日志窗格
  （时间 + 步骤只在变化时显示 + 按 `##[error]` / `##[warning]` 上色）、「只看失败」开关、两种截断各自的
  提示；「在 GitHub 打开」降为次要出口——只有日志被截断时才真需要它。
- `src/modules/remotes/RunListDialog.tsx`：行内「打开浏览器」换成「详情」，在同一个弹窗里切视图
  （不叠弹窗）。
- `src/modules/remotes/lib/runs.ts`：新增 `logLineTone`（错误/警告/分组/普通）与 `logClock`；带单测。
- `src/lib/native.ts`、`src/modules/i18n/messages.ts`：命令包装与中英文案。

**布局：左右两条缝等宽**

- `src/app/App.tsx`：中间区域的内边距从 `pl-0.5 pr-2` 改成 `pl-0.5 pr-0.5`。之前侧栏↔终端是 0.5+0.5、
  终端↔Git 是 2+0.5，右边看着宽一倍多；现在两条缝都是 2px + 分隔条 4px + 2px = 7.58px，
  窗口两侧的外边距仍由侧栏 `pl-2` 与右栏 `pr-2` 各给 8px。

**GitHub：运行列表（含重跑 / 取消）**

- `src-tauri/src/modules/github/actions.rs`：新增。解析运行列表 `repos/{owner}/{repo}/actions/runs?per_page=N`。
  逐条容错（缺 id / status / html_url 的条目丢掉，其余字段缺了按空处理）；但「返回里本来有条目、最后一条都
  没留下」按解析失败如实报，不报成「没有运行记录」。带 7 个单测。
- `src-tauri/src/modules/github/types.rs`：新增 `RepoActionRun` / `RepoActionRunsPayload` /
  `RepoRunActionResult`，空列表归 `none`（与 CI 那条同一套 kind）；`failed` 的「不返回空错误」收成一个
  小助手，CI 那条也改用它。
- `src-tauri/src/modules/github/commands.rs`：新增 `github_repo_runs`（一次一个仓库，条数夹到 1..=50，
  默认 20）、`github_run_rerun`、`github_run_cancel`（内部走 `gh run rerun/cancel <id> --repo <slug>`）。
  运行 id 是整数、拼不出选项注入；0 在本地就拒收。
- `src-tauri/src/lib.rs`、`gh.rs`、`mod.rs`：注册三条命令与 `RUN_ACTION_TIMEOUT_SECS`。
- `src/modules/remotes/RunListDialog.tsx`：新增。列出最近 20 条运行：状态徽标、workflow · 分支 · #号、
  事件、原始 conclusion、相对时间，附「打开」跳转。重跑与取消都要二次确认；失败把 gh 原文留在确认框里
  （成功先收框再刷新，刷新出问题不该让框看起来像失败）。
- `src/modules/remotes/lib/runs.ts`：新增。一行的视图规则（跑完了才能重跑、没跑完才谈得上取消）与时间解析；
  带 4 个单测。
- `src/modules/remotes/lib/ci.ts`：把 `runState` / `runDetail` / `TONE_CLASS` 抽出来给 CI 列与运行列表共用；
  顺带修掉一处不一致——`timed_out` 原本是红色徽标却写「已结束」，现在按失败说。
- `src/modules/remotes/RemoteReposView.tsx`：行菜单加「运行记录…」。
- `src/lib/native.ts`、`src/modules/i18n/messages.ts`：命令包装与中英文案。

**界面文案：补上没适配中文的输入提示词**

- `src/modules/command-palette/CommandPalette.tsx`：命令面板的四个提示词（默认 / 主题 / 文件内容 / 命令历史）
  改成走 i18n，之前是硬编码英文。
- `src/modules/header/SearchInline.tsx`：头部搜索框的「Search」与「Git search」改成走 i18n（快捷键后缀照旧拼）。
- `src/modules/explorer/FileExplorer.tsx`、`src/modules/explorer/TreeRow.tsx`：新建文件 / 新建文件夹的行内
  占位词改用 `explorer.newFile` / `explorer.newFolder` —— 这两个键早就存在，只是一直没被用上。

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

