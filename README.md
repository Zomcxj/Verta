<div align="center">
  <img src="public/logo.png" width="144" height="144" alt="Verta" />
  <h1>Verta</h1>

  <p><strong>Windows 优先的桌面工作台：会话、终端、编辑器与 Git 在一个窗口里。</strong></p>

  <p>
    <img src="https://img.shields.io/badge/platform-Windows-blue" alt="平台" />
    <img src="https://img.shields.io/badge/license-Apache--2.0-lightgrey" alt="许可" />
  </p>
</div>

---

Verta 是一个终端优先的桌面工作台，围绕「本机已经在用的编码 agent」来做：它不自己实现 agent，而是把你机器上 agent 的真实会话列出来，点一下就在原项目目录里恢复，再把终端、编辑器、Git 收在同一个窗口。基于 Tauri 2 + Rust 与 React 19 构建，渲染核心是 ghostty（WebGPU 自绘）。界面中文与 English 双语，默认跟随系统。

## 功能

### 会话

- 列出本机 agent 的真实会话，读的是它们自己的数据。
- 点一条会话就在它自己的项目目录里恢复。
- 子代理会话不展示，管理模式下才可见。
- 多选删除：删除前后端重新核对，删不掉的原因如实显示，失败不会被伪装成成功。
- 列表随会话文件变化实时更新，不需要手动刷新。

### Windows 与 WSL 并存

- WSL 侧的数据在发行版内查询，因此不受 `/mnt` 上 WAL 锁的限制。
- WSL 开关默认关闭：关的时候只停 Verta 自己的查询，不碰 WSL 本身；打开后可以选择关闭时执行 `wsl --shutdown`（那会中断 WSL 里正在跑的一切）。
- 在 WSL 里没有独立数据时，界面如实说明，而不是显示成空列表。
- 环境由路径推断，终端、文件树与状态查询始终落在同一侧。

### 终端

- 渲染核心为 ghostty（WebGPU 自绘），支持多标签与多面板拆分布局。
- agent 运行时，会话上下文里的图片显示为真位图：位图由我们从会话库取出并画在它预留的位置上，点击可看原尺寸大图。
- 从浏览器或桌面拖文件进来会转成适合 Shell 的安全引用路径。
- 会话列表与终端并存。

### 编辑器与预览

- CodeMirror 6，支持常用语言。
- 打开图片直接预览：尺寸信息、缩放、透明棋盘格。
- Markdown 里的本地图片按文档所在目录解析，受工作区白名单约束。
- 编辑器右侧实时预览。

### Git

- Git 面板在页面右侧，可与项目列表同时查看，右上角有与左上角对称的展开/收起按钮。
- 项目列表标签页展示项目、分支、状态、未提交数、上游与储藏数，可筛选与排序。
- 远程仓库标签页列出账号可访问的仓库，走本机已登录的 `gh`。
- 每个仓库的 Releases 在软件内看（版本列表、正文、附件），附件下载显示真实字节进度，落到你选的目录；失败或取消不会留下半截文件，也不会动已存在的同名文件。

### 界面

- 中文与 English 两种语言，默认跟随系统，只翻译界面可见文案。

## 环境要求

- Windows 10/11（使用系统 WebView2）
- Node.js 22 以上、pnpm 11
- Rust 稳定版工具链（构建 Tauri 后端）

## 开发

```bash
pnpm install
pnpm tauri dev      # 开发运行
pnpm tauri build    # 打包
```

## 门禁

```bash
pnpm check-types
pnpm lint
pnpm test                                   # 内存紧张时加 --maxWorkers=2

cd src-tauri
cargo clippy --all-targets -- -D warnings   # 内存紧张时加 -j 2
cargo test --lib
```

## 技术栈

Tauri 2、Rust、`portable-pty`、React 19、TypeScript、Vite、ghostty（WebGPU）、CodeMirror 6、Tailwind v4、shadcn/ui、Zustand。

## 许可

Apache-2.0，见 `LICENSE`。版权行同时保留本项目与上游项目，具体见文件开头。

## Acknowledgements

本项目基于 [Terax AI](https://github.com/crynta/terax-ai)（Apache-2.0）二次开发。与上游的差异记录在 `CHANGES.md`。