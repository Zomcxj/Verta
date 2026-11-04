export { TabBar, TabIcon } from "./TabBar";
export type { TerminalChoice } from "./NewTabMenu";
export { TabSwitcherHud } from "./TabSwitcherHud";
export { useTabSwitcher } from "./lib/useTabSwitcher";
export { labelFor } from "./lib/tabLabel";
export {
  MAX_PANES_PER_TAB,
  useTabs,
  nextActiveTab,
  planCloseTabsToRight,
  planCloseOtherTabs,
  type CloseTabsPlan,
  type Tab,
  type TabPatch,
  type EditorTab,
  type PreviewTab,
  type MarkdownTab,
  type GitDiffTab,
  type GitHistoryTab,
  type ProjectsTab,
  type NotesTab,
  type GitCommitFileDiffTab,
} from "./lib/useTabs";
export { useTabRestore, useTabPersistence } from "./lib/useTabRestore";
export { useWorkspaceCwd } from "./lib/useWorkspaceCwd";
export { useWindowTitle } from "./lib/useWindowTitle";
