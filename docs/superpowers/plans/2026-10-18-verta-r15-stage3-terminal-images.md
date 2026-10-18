# R15 阶段三：在终端里显示 agent 会话中的图片

## 目标

agent（opencode）在终端里跑的时候，会话上下文里的图片要**真的显示出来**：是位图，不是
「路径可点击」，不是色块马赛克。

## 已核实的事实（全部有抓包或现场截图）

1. **我们的终端从未应答 `CSI 14 t`**（询问文本区像素尺寸）。
   opencode 启动时会问一次（`pty-1.bin` 偏移 860 处），拿不到就静默放弃图片。
2. **应答之后 opencode 会画图片**，但它只会画**色块马赛克**（`█` `▄` `▛` 配 24 位背景色）。
   现场截图 `docs/superpowers/shots/r15-stage3-after.png` 两张图都画出来了。
3. **opencode 的位图通道在我们这里走不通**。以下组合全部得到 0 字节位图数据
   （既无 DCS `ESC P`、也无 APC `ESC _`、也无 base64 PNG）：
   - 伪造终端身份：kitty / WezTerm / ghostty / Windows Terminal（含 `WT_SESSION`）
   - 强制 `OPENTUI_IMAGE_PROTOCOL=kitty` 或 `sixel`：此时它连色块都不画
   - DA1 声明 sixel 属性位 `4`
   - 应答真实几何（180×45 格、1620×1080 px、单元 9×24 px）
   它二进制里确实有 `bufferDrawImage(...)` 和 `{auto,kitty,sixel,blocks}` 枚举，
   但那条路在本机环境下不产出数据。
4. **图片实体只在会话数据库里**：`session_message.data` 的 `files[].data` 是 base64 PNG，
   `files[].name` 是文件名（与终端里打印的 `file <名字>` 一致）。磁盘上没有对应文件。

结论：**位图必须由我们自己画**。数据源是会话数据库，位置由终端里的参考行推导。

## 设计

### 定位

opencode 用「参考行 + 上方留白（或马赛克）」表示一张图：

```
（图片区域：留白，或它画的色块马赛克）
[Image 1] <提示文字>
 file 屏幕截图 2026-05-17 131455.png
```

于是定位分两步，都只看可见网格，模型已提供 `grapheme(row, col)`、
`readCellLine(line)`、`scrollPosition()`：

1. **参考行**：某一行文本里出现 `[Image`，或出现 `.png/.jpg/.jpeg/.webp/.gif` 且同行有
   `file` 字样。文件名从该行取（同行没有就往下再看几行）。
2. **图片区域**：从参考行往上找连续的色块单元（`▀▄█▌▐▛▜▙▟▘▝▖▗▚▞` 及其它块元素）组成的
   矩形，取它的包围盒。这既是 opencode 认可的尺寸，也保证不遮挡文本。
   找不到马赛克时（例如用户自己换了协议），退化为往上找连续全空行，最多到窗口顶部。

### 取图

新增 Rust 命令：按文件名在 opencode 数据库里取回 base64。

- 只读打开（复用 `agent_sessions::opencode::open_read_only`），失败要报错，不能静默空。
- `session_message` 是 5.6 GB，**不能全表扫**。按 `rowid DESC` 倒序取最近若干行再匹配文件名，
  文件名是带时间戳的截图名，几乎不会重名；同时只取第一张命中的。
- 命中后把 `data:image/png;base64,...` 交给前端，前端用 `createImageBitmap`/`<img>` 渲染。

### 显示

- 新增终端叠加层组件（沿用 `GhosttyBlockOverlay.tsx` 的「叠加层 + 控制器」范式），
  按单元格像素把位图定位到第 2 步算出的矩形，用 `object-fit: contain` 铺满该矩形，不裁切。
- 跟随滚动与缩放：订阅模型的重绘/滚动信号重新算矩形。
- 点击图片打开全屏预览（与编辑器里的图片预览一致的行为）。
- 取不到图（数据库里没有、名字被截断）时什么都不画，保留 opencode 原本的显示。

## 步骤

1. Rust：`agent_sessions/opencode.rs` 加 `image_data_by_name`，配临时库单测。
2. 前端：`terminalImages.ts` 纯函数（找参考行、拆文件名、找马赛克包围盒），单测覆盖
   行首/行尾截断、多图相邻、滚动偏移等情形。
3. 前端：`GhosttyTerminalImages.tsx` 叠加层 + 桥接命令。
4. 接进 `TerminalPane.tsx`，真机截图验收。
5. 文档同步：设计文档 §12.6 阶段三的结论改为「由我们自己画位图」并记录上述实测证据。

## 验收

- 在 Verta 终端里打开含图会话，图片位置出现**真位图**（与源图一致，非马赛克）。
- 滚动、缩放、切换标签页后位置不漂移。
- 点击能放大。
- 图片名取不到时不报错、不遮挡。