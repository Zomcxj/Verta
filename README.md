# Verta

Windows 优先的桌面工作台：把本机 agent 会话的浏览与恢复、终端、编辑器、Git 收在一个窗口里。

## 能做什么

**会话面板（打开即见）**

- 列出本机 opencode 与 pi 的真实会话；子代理会话不展示，管理模式下才可见。
- 点一条会话，就在它自己的项目目录里恢复它（opencode 用 `--session <id>` 加目录，pi 用 id 加工作目录），不会静默新建。
- 多选真删除：删除前后端重新核对，删不掉的原因如实显示出来，失败不会被伪装成成功。
- 列表随会话文件变化实时更新，不需要手动刷新。

**Windows 与 WSL 并存**

- WSL 侧的数据在发行版内查询（脚本经 `/mnt/c/...` 传入，由发行版自己的 python3 执行），因此不受 9p 上 WAL 锁的限制。
- 设置里的 WSL 开关默认关：关的时候只停 Verta 自己的查询，不碰 WSL 本身；打开后可以选择关闭时执行 `wsl --shutdown`（那会中断 WSL 里正在跑的一切，包括 Docker Desktop 的后端）。
- pi 在 WSL 里没有独立数据（它指向 Windows 上的同一个程序），界面会如实说明，而不是显示成空列表。

**终端**

- 渲染核心是 ghostty（WebGPU 自绘）。
- agent 运行时，会话上下文里的图片会**显示为真位图**：agent 本身不发送像素数据，所以位图由我们自己从会话库里取出并画在它预留的位置上，点击可看原尺寸大图。
- 会话列表与终端并存，支持多面板布局。

**编辑器与预览**

- 打开图片直接预览（尺寸信息、缩放、透明棋盘格）。
- Markdown 里的本地图片按文档所在目录解析，受工作区白名单约束。
- 编辑器右侧实时预览（Typora 式）。

**Git**

- Git 面板放在页面右侧，可与项目列表同时查看，右侧有与左上角对称的隐藏/展开按钮。

**界面**

- 中文与 English 两种语言，默认跟随系统；只翻译界面可见文案。

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
pnpm test                                  # 内存紧张时加 --maxWorkers=2

cd src-tauri
cargo clippy --all-targets -- -D warnings   # 内存紧张时加 -j 2
cargo test --lib
```

## 文档

- 需求台账：`docs/superpowers/requirements-log.md`
- 设计文档：`docs/superpowers/specs/`
- 施工计划：`docs/superpowers/plans/`

## 许可

Apache-2.0，见 `LICENSE`。