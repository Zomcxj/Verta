import type { SearchTarget } from "@/modules/header";
import type { MessageKey } from "@/modules/i18n";
import { MAX_PANES_PER_TAB, type Tab } from "@/modules/tabs";
import { leafIds } from "@/modules/terminal";
import {
  Cancel01Icon,
  DashboardSquare01Icon,
  FileEditIcon,
  FileSearchIcon,
  Folder01Icon,
  GithubIcon,
  Globe02Icon,
  IncognitoIcon,
  KeyboardIcon,
  LayoutTwoColumnIcon,
  LayoutTwoRowIcon,
  PaintBoardIcon,
  Search01Icon,
  Settings01Icon,
  SidebarLeftIcon,
  SourceCodeIcon,
  TerminalIcon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import type { PaletteItem } from "./types";

export const COMMAND_GROUPS = [
  "cmdGroup.General",
  "cmdGroup.Tabs",
  "cmdGroup.Panes",
  "cmdGroup.Git",
  "cmdGroup.Search",
  "cmdGroup.View",
] as const;

export type CommandPaletteActionContext = {
  tabs: Tab[];
  activeId: number;
  searchTarget: SearchTarget;
  explorerRoot: string | null;
  home: string | null;
  openNewTab: () => void;
  openNewBlock: () => void;
  openNewPrivate: () => void;
  openNewEditor: () => void;
  openNewPreview: () => void;
  openProjects: () => void;
  openRemotes: () => void;
  openGitGraph: () => void;
  toggleSourceControl: () => void;
  closeActiveTabOrPane: () => void;
  splitPaneRight: () => void;
  splitPaneDown: () => void;
  focusSearch: () => void;
  focusExplorerSearch: () => void;
  toggleSidebar: () => void;
  toggleHiddenFiles: () => void;
  openSettings: () => void;
  openKeyboardShortcuts: () => void;
};

const noop = () => {};

export function createCommandItems(
  ctx: CommandPaletteActionContext,
): PaletteItem[] {
  const activeTab = ctx.tabs.find((tab) => tab.id === ctx.activeId);
  const activeTerminalTab = activeTab?.kind === "terminal" ? activeTab : null;
  const activePaneCount = activeTerminalTab
    ? leafIds(activeTerminalTab.paneTree).length
    : 0;
  const onlyOneTab = ctx.tabs.length < 2;
  const noWorkspaceRoot = !ctx.explorerRoot && !ctx.home;
  const splitDisabled: MessageKey | undefined = !activeTerminalTab
    ? "cmd.noTerminalTab"
    : activePaneCount >= MAX_PANES_PER_TAB
      ? "cmd.paneLimit"
      : undefined;
  const closeDisabled: MessageKey | undefined =
    onlyOneTab && activePaneCount < 2 ? "cmd.lastTab" : undefined;

  return [
    {
      id: "settings.open",
      title: "cmd.openSettings",
      group: "cmdGroup.General",
      keywords: ["preferences", "config"],
      icon: Settings01Icon,
      shortcutId: "settings.open",
      run: ctx.openSettings,
    },
    {
      id: "theme.pick",
      title: "cmd.changeTheme",
      group: "cmdGroup.General",
      keywords: ["theme", "appearance", "color", "dark", "light"],
      icon: PaintBoardIcon,
      run: noop,
    },
    {
      id: "shortcuts.open",
      title: "cmd.keyboardShortcuts",
      group: "cmdGroup.General",
      keywords: ["keys", "keybindings", "settings"],
      icon: KeyboardIcon,
      run: ctx.openKeyboardShortcuts,
    },
    {
      id: "tab.new",
      title: "cmd.newTerminal",
      group: "cmdGroup.Tabs",
      keywords: ["shell", "terminal", "new tab"],
      icon: TerminalIcon,
      shortcutId: "tab.new",
      run: ctx.openNewTab,
    },
    {
      id: "tab.newBlock",
      title: "cmd.newBlockTerminal",
      group: "cmdGroup.Tabs",
      keywords: ["blocks", "warp", "command blocks", "terminal"],
      icon: DashboardSquare01Icon,
      run: ctx.openNewBlock,
    },
    {
      id: "tab.newProjects",
      title: "cmd.newProjects",
      group: "cmdGroup.Tabs",
      keywords: ["projects", "repos", "repositories", "git status", "sessions"],
      icon: Folder01Icon,
      run: ctx.openProjects,
    },
    {
      id: "tab.newRemotes",
      title: "cmd.openRemotes",
      group: "cmdGroup.Tabs",
      keywords: ["github", "remote", "repositories", "repos", "account"],
      icon: GithubIcon,
      run: ctx.openRemotes,
    },
    {
      id: "tab.newPrivate",
      title: "cmd.newPrivateTerminal",
      group: "cmdGroup.Tabs",
      keywords: ["privacy", "private", "incognito", "hidden from ai"],
      icon: IncognitoIcon,
      shortcutId: "tab.newPrivate",
      run: ctx.openNewPrivate,
    },
    {
      id: "tab.newEditor",
      title: "cmd.newEditorTab",
      group: "cmdGroup.Tabs",
      keywords: ["file", "editor", "create"],
      icon: FileEditIcon,
      shortcutId: "tab.newEditor",
      disabledReason: noWorkspaceRoot ? "cmd.noWorkspaceRoot" : undefined,
      run: ctx.openNewEditor,
    },
    {
      id: "tab.newPreview",
      title: "cmd.newWebPreview",
      group: "cmdGroup.Tabs",
      keywords: ["browser", "web", "localhost", "preview"],
      icon: Globe02Icon,
      shortcutId: "tab.newPreview",
      run: ctx.openNewPreview,
    },
    {
      id: "tab.close",
      title: "cmd.closeTabOrPane",
      group: "cmdGroup.Tabs",
      keywords: ["close", "remove", "pane"],
      icon: Cancel01Icon,
      shortcutId: "tab.close",
      disabledReason: closeDisabled,
      run: ctx.closeActiveTabOrPane,
    },
    {
      id: "pane.splitRight",
      title: "cmd.splitRight",
      group: "cmdGroup.Panes",
      keywords: ["terminal", "pane", "split", "right", "column"],
      icon: LayoutTwoColumnIcon,
      shortcutId: "pane.splitRight",
      disabledReason: splitDisabled,
      run: ctx.splitPaneRight,
    },
    {
      id: "pane.splitDown",
      title: "cmd.splitDown",
      group: "cmdGroup.Panes",
      keywords: ["terminal", "pane", "split", "down", "row"],
      icon: LayoutTwoRowIcon,
      shortcutId: "pane.splitDown",
      disabledReason: splitDisabled,
      run: ctx.splitPaneDown,
    },
    {
      id: "git.graph",
      title: "cmd.openGitGraph",
      group: "cmdGroup.Git",
      keywords: ["git", "graph", "history", "log", "commits"],
      icon: SourceCodeIcon,
      run: ctx.openGitGraph,
    },
    {
      id: "git.source",
      title: "cmd.toggleSourceControl",
      group: "cmdGroup.Git",
      keywords: ["git", "source control", "changes", "staging", "diff"],
      icon: SourceCodeIcon,
      shortcutId: "pane.source",
      run: ctx.toggleSourceControl,
    },
    {
      id: "search.content",
      title: "cmd.findInFiles",
      group: "cmdGroup.Search",
      keywords: ["grep", "ripgrep", "text", "contents", "search in files"],
      icon: FileSearchIcon,
      trailing: "#",
      run: noop,
    },
    {
      id: "history.open",
      title: "cmd.searchHistory",
      group: "cmdGroup.Search",
      keywords: ["history", "shell", "rerun", "previous commands"],
      icon: TerminalIcon,
      trailing: ">",
      run: noop,
    },
    {
      id: "search.focus",
      title: "cmd.findInTab",
      group: "cmdGroup.Search",
      keywords: ["find", "terminal", "editor", "current"],
      icon: Search01Icon,
      shortcutId: "search.focus",
      disabledReason: ctx.searchTarget ? undefined : "cmd.noSearchableView",
      run: ctx.focusSearch,
    },
    {
      id: "explorer.search",
      title: "cmd.searchFilesByName",
      group: "cmdGroup.Search",
      keywords: ["explorer", "workspace", "file", "open"],
      icon: Search01Icon,
      shortcutId: "explorer.search",
      disabledReason: ctx.explorerRoot ? undefined : "cmd.noWorkspaceRoot",
      run: ctx.focusExplorerSearch,
    },
    {
      id: "sidebar.toggle",
      title: "cmd.toggleExplorer",
      group: "cmdGroup.View",
      keywords: ["sidebar", "files", "explorer"],
      icon: SidebarLeftIcon,
      shortcutId: "sidebar.toggle",
      run: ctx.toggleSidebar,
    },
    {
      id: "explorer.toggleHidden",
      title: "cmd.toggleHidden",
      group: "cmdGroup.View",
      keywords: ["dotfiles", "hidden", "explorer", "gitignore", "env"],
      icon: ViewIcon,
      shortcutId: "explorer.toggleHidden",
      run: ctx.toggleHiddenFiles,
    },
  ];
}
