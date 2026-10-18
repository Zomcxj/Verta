import type { Language } from "./language";

/**
 * The interface strings this fork owns: the session panel and the things added
 * beside it. Upstream text stays where it is until its module is translated,
 * because a half-moved module is worse to work on than an untranslated one.
 *
 * Keys are `module.name`, so a missing entry is obvious from the caller.
 */
const zh = {
  "term.runAgain": "再次运行",
  "term.blockActions": "区块操作",
  "term.copyCommand": "复制命令",
  "term.copyOutput": "复制输出",
  "term.copyBoth": "复制命令与输出",
  "term.findInBlock": "在区块内查找",
  "term.previous": "上一个",
  "term.next": "下一个",
  "term.runInTerminal": "在当前终端运行",

  "palette.title": "命令面板",
  "palette.description": "运行命令、切换主题，或搜索工作区。",
  "palette.noThemes": "没有主题",
  "palette.noWorkspaceRoot": "没有工作区根目录",
  "palette.typeMore": "至少输入 2 个字符",
  "palette.openTerminal": "打开终端以运行历史记录",
  "palette.searchFailed": "搜索失败",
  "palette.searching": "搜索中…",

  "scm.refresh": "刷新源代码管理",
  "scm.loading": "正在加载仓库",
  "scm.noRepo": "没有仓库",
  "scm.error": "源代码管理出错",
  "scm.commitMessage": "提交信息",
  "scm.changedFiles": "已更改的文件",
  "scm.stageAll": "暂存全部更改",

  "preview.reload": "重新加载",
  "preview.commonPorts": "常用开发服务器端口",
  "preview.openBrowser": "在系统浏览器中打开",
  "preview.cookieWarning": "沙箱预览中基于 Cookie 的登录可能无法使用。",
  "preview.dismissCookie": "关闭 Cookie 登录提示",
  "preview.dismiss": "关闭",
  "preview.title": "预览",

  "explorer.searchFiles": "搜索文件",
  "explorer.searchPlaceholder": "搜索文件…",
  "explorer.clearSearch": "清除搜索",
  "explorer.newFile": "新建文件",
  "explorer.newFolder": "新建文件夹",
  "explorer.refresh": "刷新",

  "spaces.defaultName": "默认",
  "spaces.title": "工作区",
  "spaces.rename": "重命名工作区",
  "spaces.newTab": "新建标签页",
  "spaces.delete": "删除工作区",
  "spaces.closeTab": "关闭标签页",

  "tabs.newTab": "新建标签页",
  "tabs.unsaved": "有未保存的更改",
  "tabs.close": "关闭标签页",
  "tabs.rename": "重命名标签页",

  "header.settings": "设置",
  "header.toggleSidebar": "显示/隐藏侧栏",
  "header.commandPalette": "命令面板",
  "header.clearSearch": "清除搜索",

  "common.copyCode": "复制代码",
  "common.loading": "加载中",

  "lsp.stopped": "语言服务器已停止",
  "lsp.dismissHint": "关闭（可在设置中重新启用）",
  "lsp.copyCommand": "复制命令",

  "statusbar.showHidden": "显示隐藏文件夹",
  "statusbar.workspaceEnv": "工作区环境",

  "shortcut.openPalette": "打开命令面板",
  "shortcut.findInFiles": "在工作区文件中搜索",
  "shortcut.openSettings": "打开设置",
  "shortcut.newTab": "新建标签页",
  "shortcut.newBlockTerminal": "新建命令块终端",
  "shortcut.newPrivateTerminal": "新建私有终端",
  "shortcut.newPreview": "新建网页预览",
  "shortcut.newEditor": "新建编辑器标签页",
  "shortcut.closeTabOrPane": "关闭标签页或面板",
  "shortcut.splitRight": "向右分屏",
  "shortcut.splitDown": "向下分屏",
  "shortcut.focusNextPane": "聚焦下一个面板",
  "shortcut.focusPrevPane": "聚焦上一个面板",
  "shortcut.swapLeft": "与左面板交换",
  "shortcut.swapRight": "与右面板交换",
  "shortcut.swapUp": "与上面板交换",
  "shortcut.swapDown": "与下面板交换",
  "shortcut.toggleSourcePanel": "显示/隐藏 Git 面板",
  "shortcut.clearTerminal": "清空终端",
  "shortcut.prevBlock": "上一个命令块",
  "shortcut.nextBlock": "下一个命令块",
  "shortcut.nextTab": "下一个标签页",
  "shortcut.prevTab": "上一个标签页",
  "shortcut.jumpToTab": "跳转到第 1–9 个标签页",
  "shortcut.nextSpace": "下一个工作区",
  "shortcut.prevSpace": "上一个工作区",
  "shortcut.openSpaces": "打开工作区列表",
  "shortcut.searchFiles": "搜索文件",
  "shortcut.findInTab": "在当前标签页内查找",
  "shortcut.toggleExplorer": "显示/隐藏文件树",
  "shortcut.toggleExplorerFocus": "聚焦文件树",
  "shortcut.toggleHidden": "显示/隐藏隐藏文件",
  "shortcut.zoomIn": "放大界面",
  "shortcut.zoomOut": "缩小界面",
  "shortcut.zoomReset": "重置界面缩放",
  "shortcut.zenMode": "切换禅模式",
  "shortcut.undo": "撤销",
  "shortcut.redo": "重做",
  "shortcut.save": "保存文件",
  "shortcut.codeComplete": "触发代码补全",

  "shortcutGroup.General": "通用",
  "shortcutGroup.Tabs": "标签页",
  "shortcutGroup.Spaces": "工作区",
  "shortcutGroup.Panes": "面板",
  "shortcutGroup.Terminal": "终端",
  "shortcutGroup.Search": "搜索",
  "shortcutGroup.View": "视图",
  "shortcutGroup.Editor": "编辑器",

  "rail.sessions": "会话",
  "rail.files": "文件",
  "rail.git": "Git",

  "launcher.manage": "管理",
  "launcher.done": "完成",
  "launcher.refresh": "刷新",
  "launcher.loading": "读取中",
  "launcher.search": "搜索标题或目录",
  "launcher.delete": "删除",
  "launcher.deleting": "删除中",
  "launcher.deleteConfirm": "删除会话",
  "launcher.deleteWarnOpencode": "删除 opencode 的父会话会连带删除它的子会话。",
  "launcher.deleteWarnPi": "删除 pi 会话时会连同该会话的产物目录一起删除。",
  "launcher.deleteWarnActive": "其中包含当前已在终端打开的会话。",
  "launcher.deleteIrreversible": "此操作不可撤销。",
  "launcher.cancel": "取消",
  "launcher.unknownReason": "未知原因",
  "launcher.clear": "清空",
  "launcher.selectAll": "全选",
  "launcher.selectedCount": "已选 {count} 条",
  "launcher.count": "{shown} / {total} 条",
  "launcher.countAll": "{total} 条",
  "launcher.unparsed": "，{count} 个文件无法解析",
  "launcher.deleteFailed": "有 {count} 条没能删除：\n{failures}",
  "launcher.deleteRequestFailed": "删除请求失败：{message}",
  "launcher.deleteTitle": "删除会话？",
  "launcher.deleteBody":
    "将从本机永久删除 {total} 条会话记录（opencode {opencode} 条、pi {pi} 条），无法撤销。",
  "launcher.deleteSubagents": "其中 {count} 条是子代理或分叉会话。",
  "launcher.failureLine": "{tool} {id}：{reason}",

  "settings.general.title": "通用",
  "settings.general.description": "外观模式、终端与启动行为。",
  "settings.appearance": "外观",
  "settings.mode.system": "跟随系统",
  "settings.mode.light": "浅色",
  "settings.mode.dark": "深色",
  "settings.appearanceHint": "主题、背景与自定义请见",
  "settings.appearanceHintTail": "标签页。",
  "settings.themes": "主题",
  "settings.zoom": "缩放",
  "settings.uiZoomLevel": "界面缩放比例",
  "settings.explorer": "资源管理器",
  "settings.showHidden.title": "显示隐藏文件",
  "settings.showHidden.description":
    "在文件树与搜索中包含以点开头的文件和文件夹（.env、.gitignore、.config）。",
  "settings.gitDecorations.title": "Git 标记",
  "settings.gitDecorations.description":
    "在文件树中给已修改的文件着色，并淡化被 gitignore 的条目。",
  "settings.terminal": "终端",
  "settings.terminalRenderer.title": "终端渲染器",
  "settings.terminalRenderer.description":
    "自动会优先使用 WebGPU，不可用时回退 WebGL。图形兼容性问题可选 WebGL。对新开的终端生效。",
  "settings.terminalRenderer.auto": "自动",
  "settings.screenReader.title": "屏幕阅读器支持",
  "settings.screenReader.description":
    "把终端输出作为可访问文本暴露出来。输出区域获得焦点时，Page Up / Page Down 浏览历史。",
  "settings.cursorBlink.title": "光标闪烁",
  "settings.cursorBlink.description":
    "让终端光标闪烁。默认关闭以降低空闲 CPU 占用，与 VS Code 和 macOS 终端一致。",
  "settings.cursorStyle.title": "光标形状",
  "settings.cursorStyle.description": "终端光标的形状。",
  "settings.fontWeight.title": "字重",
  "settings.fontWeight.description": "终端字体的粗细。",
  "settings.shell.title": "集成终端 Shell",
  "settings.shell.noBlocks": "该 Shell 不支持命令块与目录追踪。",
  "settings.shell.wslHint":
    "集成终端使用的 Shell。WSL 工作区使用该发行版的登录 Shell。已打开的标签页保持原 Shell。",
  "settings.shell.hint": "新开终端标签页使用的 Shell。已打开的标签页保持原 Shell。",
  "settings.shell.auto": "自动",
  "settings.workspaceEnv.title": "工作区环境",
  "settings.workspaceEnv.description":
    "新工作区在哪里运行（终端与智能体都适用）：Windows 或某个 WSL 发行版。已有工作区保持原设置，可在状态栏逐个切换。",
  "settings.workspaceEnv.windows": "Windows",
  "settings.letterSpacing.title": "字间距",
  "settings.letterSpacing.description":
    "字符之间额外的水平间距（像素）。可用负值收紧 Nerd Font。",
  "settings.fontSize.title": "字号",
  "settings.fontSize.description": "终端文字大小。",
  "settings.scrollback.title": "回滚行数",
  "settings.scrollback.description":
    "每个终端保留的历史行数。数值越大占用内存越多（每行约 3 KB）。",
  "settings.scrollback.lines": "{count} 行",
  "settings.confirmKill.title": "结束运行中的进程前先确认",
  "settings.confirmKill.description":
    "命令仍在运行时，关闭终端标签页或退出应用前会询问。编辑器中未保存的改动始终会确认。",
  "settings.fontFamily.title": "字体族",
  "settings.fontFamily.description":
    '用于图标的 Nerd Font 名称（例如 "CaskaydiaCove Nerd Font Mono"）。留空则自动检测。',
  "settings.fontFamily.placeholder": "自动检测",
  "settings.lsp.copyCommand": "复制安装命令",
  "settings.lsp.detectAgain": "重新检测",
  "settings.lsp.removeServer": "移除服务器",

  "settings.startup": "启动",
  "settings.restoreWindow.title": "恢复窗口位置与大小",
  "settings.restoreWindow.description":
    "下次启动时在主窗口上次的位置重新打开。",

  "settings.editor.title": "编辑器",
  "settings.editor.description": "编辑行为、保存与语言服务器。",
  "settings.editor.appearance": "外观",
  "settings.editor.fontSize.title": "字号",
  "settings.editor.fontSize.description": "代码编辑器文字大小。",
  "settings.editor.editing": "编辑",
  "settings.editor.vim.title": "Vim 模式",
  "settings.editor.vim.description": "在代码编辑器中启用 Vim 键位。",
  "settings.editor.wrap.title": "自动换行",
  "settings.editor.wrap.description": "超长行换行显示，而不是横向滚动。",
  "settings.editor.saving": "保存",
  "settings.editor.autoSave.title": "自动保存",
  "settings.editor.autoSave.description": "检测到改动后延迟一段时间自动保存。",
  "settings.editor.formatOnSave.title": "保存时格式化",
  "settings.editor.formatOnSave.description":
    "在显式保存（Cmd+S / :w）时用下方选择的格式化器处理文件。",
  "settings.editor.formatter.title": "格式化器",
  "settings.editor.formatter.description":
    "语言服务器在写入前格式化缓冲区；外部工具则作用于已保存的文件，从 PATH 调用。",
  "settings.editor.customCommand.title": "自定义命令",
  "settings.editor.customCommand.description":
    "作用于已保存的文件；{file} 会替换为带引号的路径（省略时自动追加）。",
  "settings.editor.customCommand.placeholder": "mytool --fix {file}",
  "settings.editor.overrides.title": "分语言覆盖",
  "settings.editor.overrides.description":
    "为特定语言使用不同的格式化器（例如 Python 用 Ruff）。",
  "settings.editor.overrides.add": "添加覆盖",
  "settings.editor.overrides.remove": "移除覆盖",
  "settings.editor.autoSaveDelay.title": "自动保存延迟",
  "settings.editor.autoSaveDelay.description": "未保存的改动在多久之后自动写入。",
  "settings.editor.wrapColumn.title": "换行列",
  "settings.editor.wrapColumn.description":
    "在该列软换行；编辑器更窄时会提前换行。",

  "settings.themes.title": "主题",
  "settings.themes.description": "主题、背景图片与自定义。",
  "settings.themes.create": "新建",
  "settings.themes.import": "导入 .terax-theme",
  "settings.themes.editorTheme.title": "编辑器配色",
  "settings.themes.editorTheme.description": "代码编辑器的语法配色。自动则跟随应用主题。",
  "settings.themes.editorTheme.auto": "自动（跟随应用主题）",
  "settings.themes.remove": "移除",
  "settings.themes.opacity": "不透明度",
  "settings.themes.dropImage":
    "把图片拖到这里，或点「选择图片」。保存在本机；设置之前不影响默认外观。",
  "settings.language.title": "界面语言",
  "settings.language.description": "切换整个界面的语言，立即生效。",

  "settings.themes.light": "浅色",
  "settings.themes.dark": "深色",
  "settings.themes.system": "跟随系统",
  "settings.themes.mica.title": "Mica 背景",
  "settings.themes.mica.description":
    "让标题栏、状态栏与边沟融入桌面壁纸。仅 Windows 11 支持。",
  "settings.themes.vibrancy.title": "窗口通透",
  "settings.themes.vibrancy.description":
    "让标题栏、状态栏与边沟透出窗口背后的内容。面板本身保持不透明。",
  "settings.themes.theme": "主题",
  "settings.themes.background": "背景",
  "settings.themes.replaceImage": "更换图片",
  "settings.themes.chooseImage": "选择图片",
  "settings.themes.blur": "模糊",


  "settings.shortcuts.title": "快捷键",
  "settings.shortcuts.description": "查看并自定义键盘快捷键。",
  "settings.shortcuts.search": "搜索快捷键…",
  "settings.shortcuts.resetAll": "全部重置",
  "settings.shortcuts.resetOne": "恢复默认",
  "settings.shortcuts.clearOne": "清除快捷键",
  "settings.shortcuts.unassigned": "未分配",
  "settings.shortcuts.resetTitle": "重置全部快捷键？",
  "settings.shortcuts.resetConfirm":
    "这会把你的全部自定义快捷键还原为默认值，且无法撤销。",

  "settings.about.title": "关于",
  "settings.about.tagline": "开源的智能体原生终端模拟器",
  "settings.about.github": "在 GitHub 上查看",
  "settings.about.issue": "反馈问题",

  "settings.languageSystem": "跟随系统",
  "settings.languageActive": "当前显示：{language}",

  "preview.label": "预览",
  "preview.show": "显示预览",
  "preview.hide": "隐藏预览",
  "editor.showPreview": "显示预览",
  "editor.hidePreview": "隐藏预览",
} as const;

/** Keys the tables must all define. Typed from `zh`, the language of record. */
export type MessageKey = keyof typeof zh;

const en: Record<MessageKey, string> = {
  "term.runAgain": "Run again",
  "term.blockActions": "Block actions",
  "term.copyCommand": "Copy command",
  "term.copyOutput": "Copy output",
  "term.copyBoth": "Copy command and output",
  "term.findInBlock": "Find in block",
  "term.previous": "Previous",
  "term.next": "Next",
  "term.runInTerminal": "Run in active terminal",

  "palette.title": "Command Palette",
  "palette.description": "Run a command, switch theme, or search your workspace.",
  "palette.noThemes": "No themes",
  "palette.noWorkspaceRoot": "No workspace root",
  "palette.typeMore": "Type at least 2 characters",
  "palette.openTerminal": "Open a terminal to run history",
  "palette.searchFailed": "Search failed",
  "palette.searching": "Searching...",

  "scm.refresh": "Refresh source control",
  "scm.loading": "Loading repository",
  "scm.noRepo": "No repository",
  "scm.error": "Source control error",
  "scm.commitMessage": "Commit message",
  "scm.changedFiles": "Changed files",
  "scm.stageAll": "Stage all changes",

  "preview.reload": "Reload",
  "preview.commonPorts": "Common dev-server ports",
  "preview.openBrowser": "Open in system browser",
  "preview.cookieWarning":
    "Cookie-based sign-in may not work in the sandboxed preview.",
  "preview.dismissCookie": "Dismiss cookie sign-in notice",
  "preview.dismiss": "Dismiss",
  "preview.title": "Preview",

  "explorer.searchFiles": "Search files",
  "explorer.searchPlaceholder": "Search files...",
  "explorer.clearSearch": "Clear search",
  "explorer.newFile": "New file",
  "explorer.newFolder": "New folder",
  "explorer.refresh": "Refresh",

  "spaces.defaultName": "Default",
  "spaces.title": "Spaces",
  "spaces.rename": "Rename space",
  "spaces.newTab": "New tab",
  "spaces.delete": "Delete space",
  "spaces.closeTab": "Close tab",

  "tabs.newTab": "New tab",
  "tabs.unsaved": "Unsaved changes",
  "tabs.close": "Close tab",
  "tabs.rename": "Rename tab",

  "header.settings": "Settings",
  "header.toggleSidebar": "Toggle sidebar",
  "header.commandPalette": "Command palette",
  "header.clearSearch": "Clear search",

  "common.copyCode": "Copy code",
  "common.loading": "Loading",

  "lsp.stopped": "Language server stopped",
  "lsp.dismissHint": "Dismiss (you can re-enable from Settings)",
  "lsp.copyCommand": "Copy command",

  "statusbar.showHidden": "Show hidden folders",
  "statusbar.workspaceEnv": "Workspace environment",

  "shortcut.openPalette": "Open command palette",
  "shortcut.findInFiles": "Find in files",
  "shortcut.openSettings": "Open settings",
  "shortcut.newTab": "New tab",
  "shortcut.newBlockTerminal": "New Blocks terminal",
  "shortcut.newPrivateTerminal": "New private terminal",
  "shortcut.newPreview": "New web preview",
  "shortcut.newEditor": "New editor tab",
  "shortcut.closeTabOrPane": "Close tab or pane",
  "shortcut.splitRight": "Split pane right",
  "shortcut.splitDown": "Split pane down",
  "shortcut.focusNextPane": "Focus next pane",
  "shortcut.focusPrevPane": "Focus previous pane",
  "shortcut.swapLeft": "Swap pane left",
  "shortcut.swapRight": "Swap pane right",
  "shortcut.swapUp": "Swap pane up",
  "shortcut.swapDown": "Swap pane down",
  "shortcut.toggleSourcePanel": "Toggle source panel",
  "shortcut.clearTerminal": "Clear terminal",
  "shortcut.prevBlock": "Previous command block",
  "shortcut.nextBlock": "Next command block",
  "shortcut.nextTab": "Next tab",
  "shortcut.prevTab": "Previous tab",
  "shortcut.jumpToTab": "Jump to tab 1-9",
  "shortcut.nextSpace": "Next space",
  "shortcut.prevSpace": "Previous space",
  "shortcut.openSpaces": "Open spaces",
  "shortcut.searchFiles": "Search files",
  "shortcut.findInTab": "Find in tab",
  "shortcut.toggleExplorer": "Toggle file explorer",
  "shortcut.toggleExplorerFocus": "Toggle file explorer focus",
  "shortcut.toggleHidden": "Toggle hidden files",
  "shortcut.zoomIn": "Zoom in",
  "shortcut.zoomOut": "Zoom out",
  "shortcut.zoomReset": "Reset zoom",
  "shortcut.zenMode": "Toggle zen mode",
  "shortcut.undo": "Undo",
  "shortcut.redo": "Redo",
  "shortcut.save": "Save file",
  "shortcut.codeComplete": "Trigger code completion",

  "shortcutGroup.General": "General",
  "shortcutGroup.Tabs": "Tabs",
  "shortcutGroup.Spaces": "Spaces",
  "shortcutGroup.Panes": "Panes",
  "shortcutGroup.Terminal": "Terminal",
  "shortcutGroup.Search": "Search",
  "shortcutGroup.View": "View",
  "shortcutGroup.Editor": "Editor",

  "rail.sessions": "Sessions",
  "rail.files": "Files",
  "rail.git": "Git",

  "launcher.manage": "Manage",
  "launcher.done": "Done",
  "launcher.refresh": "Refresh",
  "launcher.loading": "Reading",
  "launcher.search": "Search title or folder",
  "launcher.delete": "Delete",
  "launcher.deleting": "Deleting",
  "launcher.deleteConfirm": "Delete session",
  "launcher.deleteWarnOpencode":
    "Deleting an opencode parent session also deletes its child sessions.",
  "launcher.deleteWarnPi":
    "Deleting a pi session also deletes the artifacts folder that belongs to it.",
  "launcher.deleteWarnActive":
    "One of these is currently open in a terminal.",
  "launcher.deleteIrreversible": "This cannot be undone.",
  "launcher.cancel": "Cancel",
  "launcher.unknownReason": "unknown reason",
  "launcher.clear": "Clear",
  "launcher.selectAll": "Select all",
  "launcher.selectedCount": "{count} selected",
  "launcher.count": "{shown} / {total}",
  "launcher.countAll": "{total}",
  "launcher.unparsed": ", {count} unreadable files",
  "launcher.deleteFailed": "{count} could not be deleted:\n{failures}",
  "launcher.deleteRequestFailed": "Delete failed: {message}",
  "launcher.deleteTitle": "Delete session?",
  "launcher.deleteBody":
    "This permanently deletes {total} session records from this machine (opencode {opencode}, pi {pi}). It cannot be undone.",
  "launcher.deleteSubagents": "{count} of them are subagent or fork sessions.",
  "launcher.failureLine": "{tool} {id}: {reason}",

  "settings.general.title": "General",
  "settings.general.description": "Mode, terminal, and startup.",
  "settings.appearance": "Appearance",
  "settings.mode.system": "System",
  "settings.mode.light": "Light",
  "settings.mode.dark": "Dark",
  "settings.appearanceHint": "For theme, background and customization, see the",
  "settings.appearanceHintTail": "tab.",
  "settings.themes": "Themes",
  "settings.zoom": "Zoom",
  "settings.uiZoomLevel": "UI zoom level",
  "settings.explorer": "Explorer",
  "settings.showHidden.title": "Show hidden files",
  "settings.showHidden.description":
    "Include dot-prefixed files and folders (.env, .gitignore, .config) in the file explorer and search.",
  "settings.gitDecorations.title": "Git decorations",
  "settings.gitDecorations.description":
    "Tint changed files and dim gitignored entries in the file explorer.",
  "settings.terminal": "Terminal",
  "settings.terminalRenderer.title": "Terminal renderer",
  "settings.terminalRenderer.description":
    "Automatic uses WebGPU with WebGL fallback. Choose WebGL for graphics compatibility. Applies to new terminals.",
  "settings.terminalRenderer.auto": "Automatic",
  "settings.screenReader.title": "Screen reader support",
  "settings.screenReader.description":
    "Expose terminal output as accessible text. Page Up and Page Down browse history when the output region is focused.",
  "settings.cursorBlink.title": "Cursor blinking",
  "settings.cursorBlink.description":
    "Blink the terminal cursor. Off by default for lower idle CPU, matching VS Code and the macOS terminal.",
  "settings.cursorStyle.title": "Cursor style",
  "settings.cursorStyle.description": "Shape of the terminal cursor.",
  "settings.fontWeight.title": "Font weight",
  "settings.fontWeight.description": "Thickness of terminal characters",
  "settings.shell.title": "Integrated terminal shell",
  "settings.shell.noBlocks":
    "Command blocks and directory tracking are unavailable for this shell.",
  "settings.shell.wslHint":
    "Shell for the integrated terminal. WSL spaces use the distro login shell. Existing tabs keep their shell.",
  "settings.shell.hint":
    "Shell for new terminal tabs. Existing tabs keep their shell.",
  "settings.shell.auto": "Auto",
  "settings.workspaceEnv.title": "Workspace environment",
  "settings.workspaceEnv.description":
    "Where new spaces run, terminal and AI agent alike: Windows or a WSL distro. Existing spaces keep theirs; switch any from the status bar.",
  "settings.workspaceEnv.windows": "Windows",
  "settings.letterSpacing.title": "Letter spacing",
  "settings.letterSpacing.description":
    "Extra horizontal space between characters (px). Use negative values to tighten Nerd Fonts.",
  "settings.fontSize.title": "Font size",
  "settings.fontSize.description": "Terminal text size.",
  "settings.scrollback.title": "Scrollback",
  "settings.scrollback.description":
    "Lines of history kept per terminal. Higher uses more RAM (~3 KB / line).",
  "settings.scrollback.lines": "{count} lines",
  "settings.confirmKill.title": "Confirm before killing a running process",
  "settings.confirmKill.description":
    "Ask before closing a terminal tab or quitting while a command is still running. Unsaved editor changes are always confirmed.",
  "settings.fontFamily.title": "Font family",
  "settings.fontFamily.description":
    'Nerd Font name for icons (e.g. "CaskaydiaCove Nerd Font Mono"). Leave blank to auto-detect.',
  "settings.fontFamily.placeholder": "Auto-detect",
  "settings.lsp.copyCommand": "Copy install command",
  "settings.lsp.detectAgain": "Detect again",
  "settings.lsp.removeServer": "Remove server",

  "settings.startup": "Startup",
  "settings.restoreWindow.title": "Restore window position & size",
  "settings.restoreWindow.description":
    "Reopen the main window where you left it. Applies on next launch.",

  "settings.editor.title": "Editor",
  "settings.editor.description": "Editing behavior, saving, and language servers.",
  "settings.editor.appearance": "Appearance",
  "settings.editor.fontSize.title": "Font size",
  "settings.editor.fontSize.description": "Code editor text size.",
  "settings.editor.editing": "Editing",
  "settings.editor.vim.title": "Vim mode",
  "settings.editor.vim.description":
    "Enable Vim keybindings in the code editor.",
  "settings.editor.wrap.title": "Word wrap",
  "settings.editor.wrap.description":
    "Wrap long lines instead of scrolling horizontally.",
  "settings.editor.saving": "Saving",
  "settings.editor.autoSave.title": "Auto save",
  "settings.editor.autoSave.description":
    "Automatically save files after a delay when changes are detected.",
  "settings.editor.formatOnSave.title": "Format on save",
  "settings.editor.formatOnSave.description":
    "Format the file on explicit save (Cmd+S / :w) with the formatter below.",
  "settings.editor.formatter.title": "Formatter",
  "settings.editor.formatter.description":
    "Language server formats the buffer before writing; external tools run on the saved file from your PATH.",
  "settings.editor.customCommand.title": "Custom command",
  "settings.editor.customCommand.description":
    "Runs on the saved file; {file} is replaced with the quoted path (appended when omitted).",
  "settings.editor.customCommand.placeholder": "mytool --fix {file}",
  "settings.editor.overrides.title": "Language overrides",
  "settings.editor.overrides.description":
    "Use a different formatter for specific languages (e.g. Ruff for Python).",
  "settings.editor.overrides.add": "Add override",
  "settings.editor.overrides.remove": "Remove override",
  "settings.editor.autoSaveDelay.title": "Auto save delay",
  "settings.editor.autoSaveDelay.description":
    "Delay before unsaved changes are saved automatically.",
  "settings.editor.wrapColumn.title": "Wrap column",
  "settings.editor.wrapColumn.description":
    "Soft-wrap at this column, or earlier when the editor is narrower.",

  "settings.themes.title": "Themes",
  "settings.themes.description": "Theme, background image, and customization.",
  "settings.themes.create": "Create",
  "settings.themes.import": "Import .terax-theme",
  "settings.themes.editorTheme.title": "Editor colors",
  "settings.themes.editorTheme.description":
    "Syntax colors for the code editor. Auto follows the app theme.",
  "settings.themes.editorTheme.auto": "Auto (match app theme)",
  "settings.themes.remove": "Remove",
  "settings.themes.opacity": "Opacity",
  "settings.themes.dropImage":
    "Drop an image here or pick one. Stored locally; doesn't affect the default look until set.",
  "settings.language.title": "Interface language",
  "settings.language.description":
    "Changes the language of the whole interface, immediately.",

  "settings.themes.light": "Light",
  "settings.themes.dark": "Dark",
  "settings.themes.system": "System",
  "settings.themes.mica.title": "Mica background",
  "settings.themes.mica.description":
    "Blend the header, status bar and gutters into the desktop wallpaper. Windows 11 only.",
  "settings.themes.vibrancy.title": "Window vibrancy",
  "settings.themes.vibrancy.description":
    "Frost the header, status bar and gutters over what is behind the window. Panes stay solid.",
  "settings.themes.theme": "Theme",
  "settings.themes.background": "Background",
  "settings.themes.replaceImage": "Replace image",
  "settings.themes.chooseImage": "Choose image",
  "settings.themes.blur": "Blur",


  "settings.shortcuts.title": "Shortcuts",
  "settings.shortcuts.description": "View and customize keyboard shortcuts.",
  "settings.shortcuts.search": "Search shortcuts...",
  "settings.shortcuts.resetAll": "Reset All",
  "settings.shortcuts.resetOne": "Reset to default",
  "settings.shortcuts.clearOne": "Clear shortcut",
  "settings.shortcuts.unassigned": "Unassigned",
  "settings.shortcuts.resetTitle": "Reset all shortcuts?",
  "settings.shortcuts.resetConfirm":
    "This will revert all your custom keyboard shortcuts to their factory defaults. This action cannot be undone.",

  "settings.about.title": "About",
  "settings.about.tagline": "Open-source AI-native terminal emulator",
  "settings.about.github": "View on GitHub",
  "settings.about.issue": "Report an issue",

  "settings.languageSystem": "Follow system",
  "settings.languageActive": "Currently showing: {language}",

  "preview.label": "Preview",
  "preview.show": "Show preview",
  "preview.hide": "Hide preview",
  "editor.showPreview": "Show preview",
  "editor.hidePreview": "Hide preview",
};

export const MESSAGES: Record<Language, Record<MessageKey, string>> = { zh, en };

/**
 * Looks up a message. Falls back to the key itself rather than throwing: a
 * missing string should show up as something obviously wrong in the UI, not
 * crash the pane it was meant to label.
 */
export function translate(
  language: Language,
  key: MessageKey,
  values?: Record<string, string | number>,
): string {
  const template = MESSAGES[language][key] ?? key;
  if (!values) return template;
  // `{name}` placeholders, so word order can differ between languages.
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}
