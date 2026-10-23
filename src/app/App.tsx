import { RunCommandProvider } from "@/components/chat-code";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { consumeLaunchFiles, getLaunchDir } from "@/lib/launchDir";
import { native, type WireScreenshotSaved } from "@/lib/native";
import { IS_MAC } from "@/lib/platform";
import { quoteShellArg } from "@/lib/shellQuote";
import { useZoom } from "@/lib/useZoom";
import { isMarkdownPath } from "@/lib/utils";
import { CommandPalette, createCommandItems } from "@/modules/command-palette";
import { useControlBridge } from "@/modules/control";
import {
  type EditorPaneHandle,
  NewEditorDialog,
  useApplyEditorFontFamily,
  useApplyEditorFontSize,
  useEditorFileSync,
} from "@/modules/editor";
import { FileExplorer, type FileExplorerHandle } from "@/modules/explorer";
import type { GitHistorySearchHandle } from "@/modules/git-history";
import {
  Header,
  type SearchInlineHandle,
  type SearchTarget,
} from "@/modules/header";
import {
  type AgentSession,
  LauncherPanel,
  planSessionOpen,
} from "@/modules/launcher";
import { setLspNavigator } from "@/modules/lsp";
import type { PreviewPaneHandle } from "@/modules/preview";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { useT } from "@/modules/i18n";
import {
  basename as projectBasename,
  type ProjectEntry,
} from "@/modules/projects";
import { newSessionCommand } from "@/modules/launcher/lib/resumeCommand";
import type { AgentTool } from "@/modules/launcher";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setShowHidden } from "@/modules/settings/store";
import {
  type ShortcutHandlers,
  type ShortcutId,
  shouldDisablePaneSwapShortcut,
  useGlobalShortcuts,
} from "@/modules/shortcuts";
import {
  RIGHT_MAX_WIDTH,
  RIGHT_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SidebarRail,
  useRightPanel,
  useSidebarPanel,
} from "@/modules/sidebar";
import {
  repositoryTargetScope,
  SourceControlPanel,
  useRepositoryTargeting,
  useSourceControlContext,
} from "@/modules/source-control";
import { StatusBar } from "@/modules/statusbar";
import {
  type CloseTabsPlan,
  type TerminalChoice,
  TabSwitcherHud,
  useTabPersistence,
  useTabRestore,
  useTabSwitcher,
  useTabs,
  useWindowTitle,
  useWorkspaceCwd,
} from "@/modules/tabs";
import {
  clearFocusedTerminal,
  disposeSession,
  findLeaf,
  findLeafCwd,
  hasLeaf,
  isTerminalSurfaceTarget,
  leafHasForegroundProcess,
  leafIds,
  leafOutputBytes,
  navigateFocusedBlocks,
  type PaneBounds,
  ptyIdForLeaf,
  type TerminalPaneHandle,
  useAgentActivityStore,
  useTerminalFileDrop,
  whenSessionReady,
  writeToSession,
} from "@/modules/terminal";
import { bindTerminalWindowFocus } from "@/modules/terminal/ghostty/renderScheduling";
import { pasteIntoSession } from "@/modules/terminal/lib/terminalSessionApi";
import { subscribeWindowPresentation } from "@/modules/terminal/ghostty/windowPresentation";
import type { TerminalSearchController } from "@/modules/terminal/search/TerminalSearchController";
import {
  LivePageResizeBridge,
  ThemeProvider,
  useThemeFileEditing,
  WindowActivityBridge,
  WindowVibrancyBridge,
} from "@/modules/theme";
import { UpdaterDialog } from "@/modules/updater";
import {
  envForRoot,
  getWslHome,
  parseWorkspaceScopeKey,
  useWorkspaceEnvStore,
  type WorkspaceEnv,
  workspaceScopeKey,
} from "@/modules/workspace";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CloseDialogs } from "./components/CloseDialogs";
import { WorkspaceInputBar } from "./components/WorkspaceInputBar";
import { WorkspaceSurface } from "./components/WorkspaceSurface";
import { hasOpenPathTab, renamedPath } from "./hooks/tabCloseGuards";
import { useAppCloseGuard } from "./hooks/useAppCloseGuard";
import { useTabCloseGuards } from "./hooks/useTabCloseGuards";
import { useWorkspaceSwitcher } from "./hooks/useWorkspaceSwitcher";

// Real-application benchmark driver (scripts/app-lab). `__VERTA_BENCH__` is the literal `false`
// in a normal build, so this is `null` and neither the import nor its chunk is emitted.
const BenchBridge = __VERTA_BENCH__
  ? lazy(() => import("@/bench/BenchBridge"))
  : null;

/** Session-opening overlay: lift it once the agent's UI has painted, judged by the
 * process being up plus a few KB of fresh output. */
const AGENT_UI_POLL_MS = 120;
/**
 * Paint threshold: a full-screen TUI is several KB, while the command echoed by
 * the shell is only tens of bytes. Measured by **cumulative** output, not by
 * quiet time: a live TUI keeps repainting and is never quiet (measured:
 * opencode never stops emitting for more than 420ms once up).
 */
const AGENT_UI_PAINT_BYTES = 900;
const AGENT_UI_TIMEOUT_MS = 8000;
/** Fallback: never cover the terminal forever when the wait is inconclusive (a
 * bit longer than the timeout above; the poll usually finishes first). */
const SESSION_OPENING_FALLBACK_MS = 8500;

/** @returns a promise that resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Has the agent's UI come up? What we wait for is the **UI**, not the process.
 *
 * Two conditions: `leafHasForegroundProcess` (does the shell have a child — true
 * as soon as the agent starts) and "this leaf took in another 900+ bytes". The
 * process alone is not enough: opencode / pi take another second or two before
 * painting the first frame, and until then the screen still shows the pre-launch
 * state, so lifting early means the animation ends on a bare terminal. `base` is
 * the cumulative byte count **before** writing the command, so the echo cannot
 * account for 900 bytes but a full-screen TUI can. On timeout (8s) we lift
 * anyway — the overlay must not block the user forever.
 */
async function waitForAgentUi(leafId: number, base: number): Promise<void> {
  const deadline = Date.now() + AGENT_UI_TIMEOUT_MS;
  let processUp = false;
  while (Date.now() < deadline) {
    if (!processUp) processUp = await leafHasForegroundProcess(leafId);
    if (processUp && leafOutputBytes(leafId) - base >= AGENT_UI_PAINT_BYTES) {
      return;
    }
    await delay(AGENT_UI_POLL_MS);
  }
}

export default function App() {
  const {
    tabs,
    activeId,
    setActiveId,
    allocId,
    booted,
    replaceTabs,
    reorderTabByGap,
    markBooted,
    newTab,
    newBlockTab,
    newAgentTab,
    newAgentGroupTab,
    newPrivateTab,
    openFileTab,
    pinTab,
    newPreviewTab,
    newMarkdownTab,
    setMarkdownView,
    setOverrideLanguage,
    openGitDiffTab,
    openCommitHistoryTab,
    openProjectsTab,
    openRemoteReposTab,
    openCommitFileDiffTab,
    closeTab,
    closeTabs,
    updateTab,
    selectByIndex,
    setLeafCwd,
    focusPane,
    focusNextPaneInTab,
    swapActivePaneInDirection,
    splitActivePane,
    closeActivePane,
    closePaneByLeaf,
    resetWorkspace,
  } = useTabs(getLaunchDir() ? { cwd: getLaunchDir() } : undefined);

  // Mirror `tabs` into a ref so callbacks scheduled with `setTimeout`
  // (e.g. cdInNewTab) read the latest pane state instead of a stale closure.
  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);

  const activeTerminalTab = useMemo(() => {
    const t = tabs.find((x) => x.id === activeId);
    return t && t.kind === "terminal" ? t : null;
  }, [tabs, activeId]);
  const activeLeafId = activeTerminalTab?.activeLeafId ?? null;

  const searchAddons = useRef<Map<number, TerminalSearchController>>(new Map());
  const [activeSearchAddon, setActiveSearchAddon] =
    useState<TerminalSearchController | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const searchInlineRef = useRef<SearchInlineHandle | null>(null);
  const terminalRefs = useRef<Map<number, TerminalPaneHandle>>(new Map());
  const editorRefs = useRef<Map<number, EditorPaneHandle>>(new Map());
  const previewRefs = useRef<Map<number, PreviewPaneHandle>>(new Map());
  const [activeEditorHandle, setActiveEditorHandle] =
    useState<EditorPaneHandle | null>(null);
  const [gitHistoryHandle, setGitHistoryHandle] =
    useState<GitHistorySearchHandle | null>(null);
  const { zoomIn, zoomOut, zoomReset } = useZoom();
  useApplyEditorFontFamily();
  useApplyEditorFontSize();
  const terminalPathDropTarget = useTerminalFileDrop();
  const explorerRef = useRef<FileExplorerHandle>(null);

  // Drives session disposal off the pane tree, not React lifecycles —
  // split/unsplit re-mount components but the leaf is still live.
  const liveLeavesRef = useRef<Set<number>>(new Set());

  const clearWorkspaceState = useCallback(() => {
    for (const id of liveLeavesRef.current) disposeSession(id);
    searchAddons.current.clear();
    terminalRefs.current.clear();
    editorRefs.current.clear();
    previewRefs.current.clear();
    setActiveSearchAddon(null);
    setActiveEditorHandle(null);
  }, []);

  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const setWorkspaceEnv = useWorkspaceEnvStore((s) => s.setEnv);
  const {
    home,
    launchCwd,
    launchCwdResolved,
    adoptWorkspaceEnv,
    prepareEnv,
    applyEnv,
  } = useWorkspaceSwitcher({
    tabsRef,
    workspaceEnv,
    setWorkspaceEnv,
    resetWorkspace,
    clearWorkspaceState,
  });

  const t = useT();

  const tabsHydrated = useTabRestore({
    ready: launchCwdResolved,
    allocId,
    replaceTabs,
    markBooted,
    adoptWorkspaceEnv,
  });

  useTabPersistence({ tabs, activeId, enabled: tabsHydrated });

  useLayoutEffect(() => {
    tabsRef.current = tabs;
    activeIdRef.current = activeId;
  }, [tabs, activeId]);

  const {
    sidebarRef,
    sidebarWidthRef,
    sidebarView,
    sidebarCollapsed,
    initialSidebarCollapsed,
    persistSidebarView,
    persistSidebarCollapsed,
    toggleSidebar,
    openSidebarView,
    persistSidebarWidth,
    toggleExplorerFocus,
  } = useSidebarPanel(explorerRef);

  const {
    rightRef: rightPanelRef,
    rightWidthRef,
    rightCollapsed,
    initialRightCollapsed,
    persistRightCollapsed,
    persistRightWidth,
    toggleRightPanel,
  } = useRightPanel();

  const [newEditorOpen, setNewEditorOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [paletteInitialMode, setPaletteInitialMode] = useState<
    "commands" | "content"
  >("commands");
  const openCommandPalette = useCallback(
    (mode: "commands" | "content" = "commands") => {
      setPaletteInitialMode(mode);
      setCommandPaletteOpen(true);
    },
    [],
  );

  const activeTab = tabs.find((t) => t.id === activeId);
  const isTerminalTab = activeTab?.kind === "terminal";
  const isBlockTab = activeTerminalTab?.blocks === true;
  const isEditorTab = activeTab?.kind === "editor";
  const isGitHistoryTab = activeTab?.kind === "git-history";

  /**
   * The workspace env follows whichever env the terminal is in. The file tree's
   * root is the active terminal's cwd, and when the two disagree it goes looking
   * for a Linux path on the local filesystem (and reports an invalid path), so
   * both directions have to be kept in sync.
   */
  const followTerminalEnv = useCallback(
    async (env: WorkspaceEnv) => {
      const current = useWorkspaceEnvStore.getState().env;
      const same =
        current.kind === "local"
          ? env.kind === "local"
          : env.kind === "wsl" && env.distro === current.distro;
      if (same) return;
      await adoptWorkspaceEnv(env);
    },
    [adoptWorkspaceEnv],
  );

  const activeLeafEnv = useMemo(() => {
    if (activeTab?.kind !== "terminal") return null;
    const leaf = findLeaf(activeTab.paneTree, activeTab.activeLeafId);
    if (!leaf) return null;
    // Trust the env stored on the leaf; older tabs only kept a cwd, so infer from
    // the path (a drive letter means Windows, /home means the distro).
    return (
      leaf.workspace ?? (leaf.cwd ? envForRoot(leaf.cwd, workspaceEnv) : null)
    );
  }, [activeTab, workspaceEnv]);

  useEffect(() => {
    if (activeLeafEnv) void followTerminalEnv(activeLeafEnv);
  }, [activeLeafEnv, followTerminalEnv]);

  useEditorFileSync({ tabs, tabsRef, editorRefs });
  useThemeFileEditing({ tabsRef, openFileTab });

  const { explorerRoot, inheritedCwdForNewTab } = useWorkspaceCwd(
    activeTab,
    tabs,
    launchCwd ?? home,
  );

  useWindowTitle(activeTab, explorerRoot);

  useEffect(() => {
    setActiveSearchAddon(
      activeLeafId !== null
        ? (searchAddons.current.get(activeLeafId) ?? null)
        : null,
    );
    setActiveEditorHandle(editorRefs.current.get(activeId) ?? null);
  }, [activeId, activeLeafId]);

  const handleSearchReady = useCallback(
    (leafId: number, addon: TerminalSearchController) => {
      searchAddons.current.set(leafId, addon);
      if (leafId === activeLeafId) setActiveSearchAddon(addon);
    },
    [activeLeafId],
  );

  const disposeTab = useCallback(
    (id: number) => {
      // Terminal-leaf-keyed maps (terminalRefs/searchAddons) are pruned by
      // the effect below as the pane tree changes; only the tab-id-keyed
      // handles need explicit cleanup here.
      editorRefs.current.delete(id);
      previewRefs.current.delete(id);
      closeTab(id);
    },
    [closeTab],
  );

  const disposeTabs = useCallback(
    (anchorId: number, plan: CloseTabsPlan) => {
      const closedIds = closeTabs(anchorId, plan);
      for (const id of closedIds) {
        editorRefs.current.delete(id);
        previewRefs.current.delete(id);
      }
    },
    [closeTabs],
  );

  const disposeDeletedTabs = useCallback(
    (ids: number[]) => {
      if (ids.length === 0) return;
      // Deleting files on disk closes their tabs and may close them all; open a
      // fresh one so the window never ends up empty.
      const doomed = new Set(ids);
      if (!tabsRef.current.some((t) => !doomed.has(t.id))) newTab();
      for (const id of ids) disposeTab(id);
    },
    [disposeTab, newTab],
  );

  const {
    pendingCloseTab,
    pendingTerminalCloseTab,
    pendingDeleteTabs,
    pendingCloseMany,
    closeManyConfirming,
    handleClose,
    handleCloseTabsToRight,
    handleCloseOtherTabs,
    confirmClose,
    cancelClose,
    confirmTerminalClose,
    cancelTerminalClose,
    confirmDeleteClose,
    cancelDeleteClose,
    confirmCloseMany,
    cancelCloseMany,
    handlePathsDeleted,
  } = useTabCloseGuards({
    tabs,
    activeId,
    disposeTab,
    disposeDeletedTabs,
    disposeTabs,
  });

  const { pendingAppClose, confirmAppClose, cancelAppClose } =
    useAppCloseGuard(tabsRef);

  useEffect(() => {
    const live = new Set<number>();
    for (const t of tabs) {
      if (t.kind === "terminal") {
        for (const id of leafIds(t.paneTree)) live.add(id);
      }
    }
    for (const id of liveLeavesRef.current) {
      if (!live.has(id)) disposeSession(id);
    }
    liveLeavesRef.current = live;
    for (const k of [...terminalRefs.current.keys()])
      if (!live.has(k)) terminalRefs.current.delete(k);
    for (const k of [...searchAddons.current.keys()])
      if (!live.has(k)) searchAddons.current.delete(k);
  }, [tabs]);

  useEffect(() => {
    const tab = tabsRef.current.find((t) => t.id === activeId);
    if (tab?.kind !== "terminal") return;
    const ptyIds = leafIds(tab.paneTree).flatMap((leafId) => {
      const ptyId = ptyIdForLeaf(leafId);
      return ptyId === null ? [] : [ptyId];
    });
    useAgentActivityStore.getState().acknowledgeAttention(ptyIds);
  }, [activeId]);

  // Most-recently-used tab ids, most recent first, pruned to live tabs. Drives
  // the Ctrl+Tab quick switcher so it cycles by recency, not strip order.
  const mruRef = useRef<number[]>([activeId]);
  useEffect(() => {
    mruRef.current = [
      activeId,
      ...mruRef.current.filter((id) => id !== activeId),
    ];
  }, [activeId]);
  useEffect(() => {
    const live = new Set(tabs.map((t) => t.id));
    mruRef.current = mruRef.current.filter((id) => live.has(id));
  }, [tabs]);

  const getSwitcherOrder = useCallback(() => {
    const ids = tabsRef.current.map((t) => t.id);
    const present = new Set(ids);
    const ordered = mruRef.current.filter((id) => present.has(id));
    for (const id of ids) if (!ordered.includes(id)) ordered.push(id);
    return [activeId, ...ordered.filter((id) => id !== activeId)];
  }, [activeId]);

  const { state: switcherState, step: stepSwitcher } = useTabSwitcher({
    getOrder: getSwitcherOrder,
    onCommit: (id) => {
      if (tabsRef.current.some((t) => t.id === id)) setActiveId(id);
    },
  });

  const captureActiveSelection = useCallback((): string | null => {
    const t = tabs.find((x) => x.id === activeId);
    if (!t) return null;
    if (t.kind === "terminal") {
      const lid = t.activeLeafId;
      return terminalRefs.current.get(lid)?.getSelection() ?? null;
    }
    if (t.kind === "editor") {
      return editorRefs.current.get(activeId)?.getSelection() ?? null;
    }
    return null;
  }, [tabs, activeId]);

  /**
   * cwd for a new local terminal. Never inherit a WSL path: that is a directory
   * inside the distro and would be invalid for PowerShell.
   */
  const localCwdForNewTab = useCallback(async () => {
    const inherited = inheritedCwdForNewTab();
    if (inherited && /^[A-Za-z]:[\\/]/.test(inherited)) return inherited;
    try {
      return (await homeDir()).replace(/\\/g, "/");
    } catch {
      return undefined;
    }
  }, [inheritedCwdForNewTab]);

  /**
   * Open a specific terminal picked from the plus-button popover. For WSL the cwd
   * is the distro's own home: a local path means nothing there, and leaving it
   * empty makes the file tree fall back to the previous terminal's path and look
   * for a Windows directory inside WSL.
   */
  const openTerminalChoice = useCallback(
    async ({ shell, env }: TerminalChoice) => {
      const cwd =
        env.kind === "wsl"
          ? await getWslHome(env.distro).catch(() => undefined)
          : await localCwdForNewTab();
      // Resolve and authorize the home dir first, then switch env and open the tab
      // in one commit. Landing them separately leaves a frame where the file tree
      // searches the new env with the old root, flashing a "path not found".
      const nextHome = await prepareEnv(env);
      applyEnv(env, nextHome ?? cwd ?? null);
      newTab(cwd, { shell, workspace: env });
    },
    [newTab, prepareEnv, applyEnv, localCwdForNewTab],
  );

  /**
   * Plain new terminal (Ctrl+T, command palette, "default terminal" in the plus
   * menu). The env comes from the default-env preference: the workspace env
   * drifts to WSL along with open terminals, but "default terminal" is whatever
   * settings say and should not drift, otherwise clicking the local terminal
   * inside a WSL project would still open a shell in the distro.
   */
  const openNewTab = useCallback(() => {
    void openTerminalChoice({
      env: parseWorkspaceScopeKey(
        usePreferencesStore.getState().defaultWorkspaceEnv,
      ),
    });
  }, [openTerminalChoice]);

  /** Projects tab (center area, one per workspace). */
  const openProjects = useCallback(() => {
    openProjectsTab(t("tabs.new.projects"));
  }, [openProjectsTab, t]);

  /** Remote repos tab (center area, one per workspace, showing the account-level
   * list read by the local gh). */
  const openRemotes = useCallback(() => {
    openRemoteReposTab(t("remotes.tabTitle"));
  }, [openRemoteReposTab, t]);

  const openNewPrivateTab = useCallback(() => {
    newPrivateTab(inheritedCwdForNewTab());
  }, [newPrivateTab, inheritedCwdForNewTab]);

  const openNewBlockTab = useCallback(() => {
    newBlockTab(inheritedCwdForNewTab());
  }, [newBlockTab, inheritedCwdForNewTab]);

  /**
   * The transition layer shown while a session opens (see
   * `SessionOpeningOverlay`). Resuming a session writes a command into the
   * terminal and the line shows up the instant it lands; this layer covers that
   * moment while the write goes through. The timer is a fallback — a slow session
   * must not block the UI indefinitely.
   */
  const [sessionOpening, setSessionOpening] = useState(false);
  const sessionOpeningTimer = useRef<number | null>(null);
  const scheduleHideSessionOpening = useCallback((ms: number) => {
    if (sessionOpeningTimer.current !== null) {
      window.clearTimeout(sessionOpeningTimer.current);
    }
    sessionOpeningTimer.current = window.setTimeout(() => {
      sessionOpeningTimer.current = null;
      setSessionOpening(false);
    }, ms);
  }, []);
  const showSessionOpening = useCallback(() => {
    setSessionOpening(true);
    scheduleHideSessionOpening(SESSION_OPENING_FALLBACK_MS);
  }, [scheduleHideSessionOpening]);
  /** Lift the transition layer. */
  const hideSessionOpening = useCallback(() => {
    if (sessionOpeningTimer.current !== null) {
      window.clearTimeout(sessionOpeningTimer.current);
      sessionOpeningTimer.current = null;
    }
    setSessionOpening(false);
  }, []);
  useEffect(
    () => () => {
      if (sessionOpeningTimer.current !== null) {
        window.clearTimeout(sessionOpeningTimer.current);
      }
    },
    [],
  );

  const handleOpenSession = useCallback(
    (session: AgentSession) => {
      // The session decides both env and command: a local session has to run in a
      // local terminal. Do not let the terminal guess the current env, or a local
      // session started from a WSL terminal gets a local command in a distro shell.
      const plan = planSessionOpen(session);
      if (!plan) {
        console.error("[verta] refusing to build a resume command", session.id);
        return;
      }
      const { leafId } = newAgentTab(
        plan.cwd,
        session.title,
        plan.workspace,
        session.tool,
      );
      setActiveSessionId(session.id);
      // Cover the moment the command lands in the terminal (see
      // SessionOpeningOverlay).
      showSessionOpening();
      void (async () => {
        await whenSessionReady(leafId);
        // Snapshot the output counter before writing: later growth is what got
        // painted on screen.
        const baseBytes = leafOutputBytes(leafId);
        if (!writeToSession(leafId, `${plan.command}\r`)) {
          console.error(`[verta] terminal ${leafId} closed before resume`);
          hideSessionOpening();
          return;
        }
        // Wait for the agent's UI before lifting: lifting early exposes a terminal
        // with the command just typed into it.
        await waitForAgentUi(leafId, baseBytes);
        hideSessionOpening();
      })();
    },
    [newAgentTab, showSessionOpening, hideSessionOpening],
  );

  const handleNewProjectSession = useCallback(
    (entry: ProjectEntry, tool: AgentTool) => {
      const distro =
        entry.workspace.kind === "wsl" ? entry.workspace.distro : null;
      const command = newSessionCommand(tool, distro);
      const { leafId } = newAgentTab(
        entry.path,
        projectBasename(entry.path),
        entry.workspace,
        tool,
      );
      showSessionOpening();
      void (async () => {
        await whenSessionReady(leafId);
        const baseBytes = leafOutputBytes(leafId);
        if (!writeToSession(leafId, `${command}\r`)) {
          console.error(
            `[verta] terminal ${leafId} closed before starting ${tool}`,
          );
          hideSessionOpening();
          return;
        }
        await waitForAgentUi(leafId, baseBytes);
        hideSessionOpening();
      })();
    },
    [newAgentTab, showSessionOpening, hideSessionOpening],
  );

  /** "Open in terminal" on a project row: just opens a plain terminal tab there. */
  const handleOpenProjectTerminal = useCallback(
    (entry: ProjectEntry) => {
      newTab(entry.path, { workspace: entry.workspace });
    },
    [newTab],
  );

  /**
   * Clicking a project row: switch to that project's env (local / WSL) and open a
   * terminal at the project root.
   *
   * The project list is the only way in to a project. This used to be "one
   * project, one workspace", with a workspace switcher in the UI.
   */
  const handleOpenProject = useCallback(
    (entry: ProjectEntry) => {
      void adoptWorkspaceEnv(entry.workspace);
      handleOpenProjectTerminal(entry);
    },
    [adoptWorkspaceEnv, handleOpenProjectTerminal],
  );

  /** The markdown preview draws a "Run" button on fenced commands; it sends to
   * whichever terminal is active, the same way a resumed session does. */
  const runInActiveTerminal = useCallback(
    (command: string) =>
      activeLeafId !== null && writeToSession(activeLeafId, `${command}\r`),
    [activeLeafId],
  );

  const sendCd = useCallback(
    (path: string) => {
      if (activeLeafId === null) return;
      const term = terminalRefs.current.get(activeLeafId);
      if (!term) return;
      term.write(`cd ${quoteShellArg(path)}\r`);
      term.focus();
    },
    [activeLeafId],
  );

  const cdInNewTab = useCallback(
    (path: string) => {
      const tabId = newTab(path);
      setTimeout(() => {
        const tab = tabsRef.current.find((x) => x.id === tabId);
        if (!tab || tab.kind !== "terminal") return;
        const t = terminalRefs.current.get(tab.activeLeafId);
        if (!t) return;
        t.write(`cd ${quoteShellArg(path)}\r`);
        t.focus();
      }, 80);
    },
    [newTab],
  );

  const handleOpenFile = useCallback(
    (path: string, pin?: boolean) => {
      // Markdown opens in its rendered view by default; a per-tab toggle flips
      // it to the raw editor. Other files default to preview (pin=false);
      // explicit actions like context-menu "Open" pass pin=true to persist.
      if (isMarkdownPath(path)) newMarkdownTab(path);
      else openFileTab(path, pin ?? false);
    },
    [openFileTab, newMarkdownTab],
  );

  const openLaunchFiles = useCallback(
    (paths: string[]) => {
      for (const path of paths) handleOpenFile(path, true);
    },
    [handleOpenFile],
  );

  // Warm start: the backend emits once the window already exists. Attach on
  // mount so an "Open With" that lands mid-restore isn't dropped — the backend
  // also seeds the drain-once state, so the boot drain below is the safety net.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    (async () => {
      const off = await listen<string[]>("verta:open-file", (e) => {
        openLaunchFiles(e.payload);
      });
      if (disposed) off();
      else unlisten = off;
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openLaunchFiles]);

  // Cold start: files arrive as CLI args (Linux/Windows) or the macOS open-files
  // event, and get_launch_files drains them once. Wait for `booted` — the spaces
  // restore ends in replaceTabs(), which overwrites the whole tab list and would
  // discard a launch tab opened before it, making the file flash open and vanish.
  // Booting first also lands the tab in the restored active space, and lets
  // openFileTab dedupe against a session that already had the file open.
  useEffect(() => {
    if (!booted) return;
    void (async () => {
      openLaunchFiles(await consumeLaunchFiles());
    })();
  }, [booted, openLaunchFiles]);

  const handleExplorerPathRenamed = useCallback(
    (from: string, to: string) => {
      for (const tab of tabsRef.current) {
        if (tab.kind !== "editor" && tab.kind !== "markdown") continue;
        const path = renamedPath(tab.path, from, to);
        if (path === null) continue;
        const i = path.lastIndexOf("/");
        updateTab(tab.id, {
          path,
          title: i === -1 ? path : path.slice(i + 1),
        });
      }
    },
    [updateTab],
  );

  const canReplaceExplorerPath = useCallback(
    (path: string) => !hasOpenPathTab(tabsRef.current, path),
    [],
  );

  const activeTerminalLeafCwd =
    activeTab?.kind === "terminal"
      ? (findLeafCwd(activeTab.paneTree, activeTab.activeLeafId) ??
        activeTab.cwd ??
        null)
      : null;

  const activeFilePath = (() => {
    if (activeTab?.kind === "editor") return activeTab.path;
    if (activeTab?.kind === "git-diff") {
      if (/^([A-Za-z]:|\/|\\)/.test(activeTab.path)) return activeTab.path;
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    if (activeTab?.kind === "git-commit-file") {
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    return null;
  })();
  const explorerActiveFilePath =
    activeTab?.kind === "editor" || activeTab?.kind === "markdown"
      ? activeTab.path
      : null;
  const isRepositoryContextCurrent = useCallback((workspaceKey: string) => {
    const currentEnv = workspaceScopeKey(useWorkspaceEnvStore.getState().env);
    // The pin is scoped to the workspace root too (see `repositoryTargetScope`), and
    // only the environment has to have stayed the same for a resolved repo to apply.
    return workspaceKey.startsWith(`${currentEnv}\u0000`);
  }, []);
  const openSourceControl = useCallback(() => {
    toggleRightPanel();
  }, [toggleRightPanel]);
  const toggleHiddenFiles = useCallback(() => {
    openSidebarView("explorer");
    void setShowHidden(!usePreferencesStore.getState().showHidden);
  }, [openSidebarView]);
  const {
    repositoryTarget: sourceControlRepositoryTarget,
    openInSourceControl: handleOpenRepositoryInSourceControl,
    openGitHistory: handleOpenGitHistoryForPath,
    followActiveContext: handleFollowRepositoryContext,
  } = useRepositoryTargeting({
    workspaceKey: repositoryTargetScope(
      workspaceScopeKey(workspaceEnv),
      explorerRoot,
    ),
    isContextCurrent: isRepositoryContextCurrent,
    openSourceControl,
    openCommitHistoryTab,
  });
  const explorerGitDecorations = usePreferencesStore(
    (s) => s.explorerGitDecorations,
  );
  const { sourceControl, openGitGraphFromContext } = useSourceControlContext({
    activeTab,
    tabs,
    activeTerminalLeafCwd,
    explorerRoot,
    launchCwd,
    launchCwdResolved,
    home,
    sidebarView,
    sidebarCollapsed,
    gitPanelOpen: !rightCollapsed,
    explorerGitDecorations,
    repositoryTarget: sourceControlRepositoryTarget,
    openCommitHistoryTab,
  });

  const openPreviewTab = useCallback(
    (url: string) => {
      const id = newPreviewTab(url);
      // Focus the address bar if the URL is empty so the user can type.
      if (!url) {
        setTimeout(() => previewRefs.current.get(id)?.focusAddressBar(), 0);
      }
      return id;
    },
    [newPreviewTab],
  );

  const splitActivePaneInActiveTab = useCallback(
    (dir: "row" | "col") => {
      const t = tabsRef.current.find((x) => x.id === activeId);
      if (!t || t.kind !== "terminal") return;
      splitActivePane(activeId, dir);
    },
    [activeId, splitActivePane],
  );

  const livePaneBounds = useCallback((tabId: number): PaneBounds[] => {
    const tab = document.querySelector<HTMLElement>(
      `[data-terminal-tab="${tabId}"]`,
    );
    if (!tab) return [];
    return [...tab.querySelectorAll<HTMLElement>("[data-pane-leaf]")].flatMap(
      (element) => {
        const id = Number(element.dataset.paneLeaf);
        if (!Number.isFinite(id)) return [];
        const { left, right, top, bottom } = element.getBoundingClientRect();
        return [{ id, left, right, top, bottom }];
      },
    );
  }, []);

  const swapActivePane = useCallback(
    (direction: "left" | "right" | "up" | "down") => {
      swapActivePaneInDirection(activeId, direction, livePaneBounds(activeId));
    },
    [activeId, livePaneBounds, swapActivePaneInDirection],
  );

  const handleCloseTabOrPane = useCallback(() => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    if (t?.kind === "terminal" && leafIds(t.paneTree).length > 1) {
      closeActivePane(activeId);
      return;
    }
    void handleClose(activeId);
  }, [activeId, closeActivePane, handleClose]);

  const [zenMode, setZenMode] = useState(false);

  const shortcutHandlers = useMemo<ShortcutHandlers>(
    () => ({
      "commandPalette.open": () => openCommandPalette("commands"),
      "commandPalette.content": () => openCommandPalette("content"),
      "tab.new": openNewTab,
      "tab.newBlock": openNewBlockTab,
      "tab.newPrivate": openNewPrivateTab,
      "tab.newPreview": () => openPreviewTab(""),
      "tab.newEditor": () => setNewEditorOpen(true),
      "tab.close": handleCloseTabOrPane,
      "tab.next": () => stepSwitcher(1),
      "tab.prev": () => stepSwitcher(-1),
      "tab.selectByIndex": (e) => selectByIndex(parseInt(e.key, 10) - 1),
      "pane.splitRight": () => splitActivePaneInActiveTab("row"),
      "pane.splitDown": () => splitActivePaneInActiveTab("col"),
      "pane.focusNext": () => focusNextPaneInTab(activeId, 1),
      "pane.focusPrev": () => focusNextPaneInTab(activeId, -1),
      "pane.swapLeft": () => swapActivePane("left"),
      "pane.swapRight": () => swapActivePane("right"),
      "pane.swapUp": () => swapActivePane("up"),
      "pane.swapDown": () => swapActivePane("down"),
      "pane.source": toggleRightPanel,
      "terminal.clear": () => {
        clearFocusedTerminal();
      },
      "blocks.prev": () => navigateFocusedBlocks(-1),
      "blocks.next": () => navigateFocusedBlocks(1),
      "search.focus": () => {
        const editor = editorRefs.current.get(activeId);
        if (editor) editor.openSearch();
        else searchInlineRef.current?.focus();
      },
      "settings.open": () => void openSettingsWindow(),
      "sidebar.toggle": toggleSidebar,
      "explorer.focus": toggleExplorerFocus,
      "explorer.toggleHidden": toggleHiddenFiles,
      "view.zoomIn": zoomIn,
      "view.zoomOut": zoomOut,
      "view.zoomReset": zoomReset,
      "view.zenMode": () => setZenMode((v) => !v),
      "editor.undo": () => editorRefs.current.get(activeId)?.undo(),
      "editor.redo": () => editorRefs.current.get(activeId)?.redo(),
      "editor.save": () => {
        void editorRefs.current.get(activeId)?.save();
      },
      "editor.codeComplete": () =>
        editorRefs.current.get(activeId)?.triggerCodeComplete(),
    }),
    [
      activeId,
      openCommandPalette,
      stepSwitcher,
      handleCloseTabOrPane,
      openNewTab,
      openNewBlockTab,
      openNewPrivateTab,
      openPreviewTab,
      selectByIndex,
      splitActivePaneInActiveTab,
      focusNextPaneInTab,
      swapActivePane,
      toggleRightPanel,
      toggleSidebar,
      toggleExplorerFocus,
      toggleHiddenFiles,
      zoomIn,
      zoomOut,
      zoomReset,
    ],
  );

  const shortcutsDisabled = useCallback(
    (id: ShortcutId, e: KeyboardEvent) => {
      const terminalPaneCount =
        activeTab?.kind === "terminal"
          ? leafIds(activeTab.paneTree).length
          : null;
      if (shouldDisablePaneSwapShortcut(id, terminalPaneCount)) return true;
      if (
        id === "editor.undo" ||
        id === "editor.redo" ||
        id === "editor.save" ||
        id === "editor.codeComplete"
      ) {
        return activeTab?.kind !== "editor";
      }
      if (id === "terminal.clear") {
        // Only intercept ⌘K while a terminal is focused; elsewhere let the key
        // fall through (we never preventDefault when disabled).
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        return !isTerminalSurfaceTarget(target);
      }
      if (id === "blocks.prev" || id === "blocks.next") {
        return !(activeTab?.kind === "terminal" && activeTab.blocks === true);
      }
      if (id === "sidebar.toggle") {
        // Ctrl+B is also Claude Code's "run in background" key. While a terminal
        // is focused, let Ctrl+B reach the shell/Claude instead of toggling the
        // sidebar. Ctrl+Shift+B (second binding) still toggles it from anywhere.
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        const inTerminal = isTerminalSurfaceTarget(target);
        // Only defer the plain (no-shift) Ctrl/⌘+B binding; the Shift variant
        // is the always-on toggle and is never claimed by the terminal.
        return inTerminal && !e.shiftKey;
      }
      return false;
    },
    [activeTab, captureActiveSelection],
  );

  useGlobalShortcuts(shortcutHandlers, { isDisabled: shortcutsDisabled });

  const registerTerminalHandle = useCallback(
    (leafId: number, h: TerminalPaneHandle | null) => {
      if (h) terminalRefs.current.set(leafId, h);
      else terminalRefs.current.delete(leafId);
    },
    [],
  );

  const registerEditorHandle = useCallback(
    (id: number, h: EditorPaneHandle | null) => {
      if (h) {
        editorRefs.current.set(id, h);
        const pending = pendingEditorNavigation.current.get(id);
        if (pending != null) {
          pendingEditorNavigation.current.delete(id);
          if (pending.line === undefined) h.focus();
          else h.gotoLine(pending.line, { focus: pending.focus });
        }
      } else {
        editorRefs.current.delete(id);
      }
      if (id === activeId) setActiveEditorHandle(h);
    },
    [activeId],
  );

  const registerPreviewHandle = useCallback(
    (id: number, h: PreviewPaneHandle | null) => {
      if (h) previewRefs.current.set(id, h);
      else previewRefs.current.delete(id);
    },
    [],
  );

  const handlePreviewUrl = useCallback(
    (id: number, url: string) => updateTab(id, { url }),
    [updateTab],
  );

  const authorizedCwds = useRef(new Set<string>());
  const handleTerminalCwd = useCallback(
    (leafId: number, cwd: string) => {
      setLeafCwd(leafId, cwd);
      if (cwd && !authorizedCwds.current.has(cwd)) {
        authorizedCwds.current.add(cwd);
        native.workspaceAuthorize(cwd).catch(() => {
          authorizedCwds.current.delete(cwd);
        });
      }
    },
    [setLeafCwd],
  );

  const handleFocusLeaf = useCallback(
    (tabId: number, leafId: number) => focusPane(tabId, leafId),
    [focusPane],
  );

  const handleLeafExit = useCallback(
    (leafId: number, _code: number) => {
      const all = tabsRef.current;
      const tab = all.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
      );
      if (!tab || tab.kind !== "terminal") return;
      // Last pane of the last tab: quit instead of respawning a shell.
      if (leafIds(tab.paneTree).length === 1 && all.length === 1) {
        void getCurrentWindow().close();
      } else {
        closePaneByLeaf(leafId);
      }
    },
    [closePaneByLeaf],
  );

  const handleEditorDirty = useCallback(
    (id: number, dirty: boolean) => updateTab(id, { dirty }),
    [updateTab],
  );

  const handleRenameTab = useCallback(
    (id: number, title: string) => updateTab(id, { customTitle: title.trim() }),
    [updateTab],
  );

  const searchTarget = useMemo<SearchTarget>(() => {
    if (isTerminalTab && activeLeafId !== null && activeSearchAddon)
      return {
        kind: "terminal",
        addon: activeSearchAddon,
        focus: () => terminalRefs.current.get(activeLeafId)?.focus(),
      };
    if (isEditorTab && activeEditorHandle)
      return {
        kind: "editor",
        handle: activeEditorHandle,
        focus: () => activeEditorHandle.focus(),
      };
    if (isGitHistoryTab && gitHistoryHandle)
      return {
        kind: "git-history",
        handle: gitHistoryHandle,
        focus: () => {},
      };
    return null;
  }, [
    isTerminalTab,
    isEditorTab,
    isGitHistoryTab,
    activeLeafId,
    activeSearchAddon,
    activeEditorHandle,
    gitHistoryHandle,
  ]);

  const activeCwd = activeTerminalLeafCwd;

  const commandPaletteItems = useMemo(
    () =>
      commandPaletteOpen
        ? createCommandItems({
            tabs,
            activeId,
            searchTarget,
            explorerRoot,
            home,
            openNewTab,
            openNewBlock: openNewBlockTab,
            openNewPrivate: openNewPrivateTab,
            openNewEditor: () => setNewEditorOpen(true),
            openNewPreview: () => openPreviewTab(""),
            openProjects,
            openRemotes,
            openGitGraph: openGitGraphFromContext,
            toggleSourceControl: toggleRightPanel,
            closeActiveTabOrPane: handleCloseTabOrPane,
            splitPaneRight: () => splitActivePaneInActiveTab("row"),
            splitPaneDown: () => splitActivePaneInActiveTab("col"),
            focusSearch: () => searchInlineRef.current?.focus(),
            focusExplorerSearch: () => explorerRef.current?.focusSearch(),
            toggleSidebar,
            toggleHiddenFiles,
            openSettings: () => void openSettingsWindow(),
            openKeyboardShortcuts: () => void openSettingsWindow("shortcuts"),
          })
        : [],
    [
      commandPaletteOpen,
      tabs,
      activeId,
      searchTarget,
      explorerRoot,
      home,
      openNewTab,
      openNewBlockTab,
      openNewPrivateTab,
      openPreviewTab,
      openGitGraphFromContext,
      toggleRightPanel,
      handleCloseTabOrPane,
      splitActivePaneInActiveTab,
      toggleSidebar,
      toggleHiddenFiles,
    ],
  );

  const pendingEditorNavigation = useRef<
    Map<number, { line?: number; focus: boolean }>
  >(new Map());
  const openContentHit = useCallback(
    (path: string, line: number) => {
      const id = openFileTab(path, true);
      if (id == null) return;
      const h = editorRefs.current.get(id);
      if (h) h.gotoLine(line);
      else pendingEditorNavigation.current.set(id, { line, focus: true });
    },
    [openFileTab],
  );

  const openControlFile = useCallback(
    ({
      path,
      line,
      focus,
    }: {
      path: string;
      line?: number;
      focus: boolean;
    }) => {
      const id = openFileTab(path, true, { activate: focus });
      const editor = editorRefs.current.get(id);
      if (line !== undefined) {
        if (editor) editor.gotoLine(line, { focus });
        else pendingEditorNavigation.current.set(id, { line, focus });
      } else if (focus) {
        if (editor) editor.focus();
        else pendingEditorNavigation.current.set(id, { focus: true });
      }
      return id;
    },
    [openFileTab],
  );

  useControlBridge({
    ready: tabsHydrated && launchCwdResolved,
    tabsRef,
    activeTabIdRef: activeIdRef,
    onOpen: openControlFile,
  });

  useEffect(() => {
    setLspNavigator({ openFile: openContentHit });
    return () => setLspNavigator(null);
  }, [openContentHit]);

  const insertHistoryCommand = useMemo(
    () =>
      isTerminalTab && activeLeafId !== null
        ? (cmd: string) => {
            writeToSession(activeLeafId, cmd);
            terminalRefs.current.get(activeLeafId)?.focus();
          }
        : null,
    [isTerminalTab, activeLeafId],
  );

  /** Region capture: the backend grabs the screen and opens the overlay; on
   * selection it crops, saves, and copies to the clipboard. */
  const startScreenshot = useCallback(() => {
    void native.screenshotBegin().catch((e) => {
      toast.error(t("screenshot.failed", { error: String(e) }));
    });
  }, [t]);

  /**
   * Follow-up toast once the screenshot is saved.
   *
   * "Insert path" only shows on a terminal tab: anywhere else the button has
   * nowhere to insert, so it is better to omit it than to offer a dead click.
   * It inserts raw text without a trailing newline — the user usually wants to
   * keep typing arguments.
   */
  useEffect(() => {
    let disposed = false;
    let stops: Array<() => void> = [];
    const canInsert = isTerminalTab && activeLeafId !== null;
    const insertPath = (path: string) => {
      if (activeLeafId === null) return;
      // Use bracketed paste so a path with spaces or CJK is not parsed as a command.
      pasteIntoSession(activeLeafId, path);
      terminalRefs.current.get(activeLeafId)?.focus();
    };
    void (async () => {
      const offSaved = await listen<WireScreenshotSaved>(
        "screenshot:saved",
        (event) => {
          const saved = event.payload;
          toast.success(t("screenshot.saved"), {
            description: saved.clipboardError
              ? t("screenshot.notCopied", {
                  path: saved.path,
                  error: saved.clipboardError,
                })
              : t("screenshot.copied", { path: saved.path }),
            action: canInsert
              ? {
                  label: t("screenshot.insertPath"),
                  onClick: () => insertPath(saved.path),
                }
              : undefined,
          });
        },
      );
      const offFailed = await listen<string>("screenshot:failed", (event) => {
        toast.error(t("screenshot.failed", { error: event.payload }));
      });
      if (disposed) {
        offSaved();
        offFailed();
        return;
      }
      stops = [offSaved, offFailed];
    })();
    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, [t, activeLeafId, isTerminalTab]);

  const shell = (
    <ThemeProvider>
      <TooltipProvider>
        {BenchBridge && (
          <Suspense fallback={null}>
            <BenchBridge
              tabs={tabs}
              activeId={activeId}
              booted={booted}
              setActiveId={setActiveId}
              newTab={newTab}
              newBlockTab={newBlockTab}
              newAgentGroupTab={newAgentGroupTab}
              splitActivePane={splitActivePane}
              closeTab={closeTab}
              readBuffer={(leafId, maxLines) =>
                terminalRefs.current.get(leafId)?.getBuffer(maxLines) ?? null
              }
            />
          </Suspense>
        )}
        <div className="relative flex h-screen flex-col overflow-hidden bg-frame text-foreground">
          {!zenMode && (
            <Header
              tabs={tabs}
              activeId={activeId}
              onSelect={setActiveId}
              onNew={openNewTab}
              onNewTerminal={openTerminalChoice}
              onNewBlock={openNewBlockTab}
              onNewPrivate={openNewPrivateTab}
              onNewPreview={() => openPreviewTab("")}
              onNewEditor={() => setNewEditorOpen(true)}
              onNewGitGraph={openGitGraphFromContext}
              onNewProjects={openProjects}
              onOpenRemotes={openRemotes}
              onClose={handleClose}
              onCloseTabsToRight={handleCloseTabsToRight}
              onCloseOtherTabs={handleCloseOtherTabs}
              onPin={pinTab}
              onRename={handleRenameTab}
              onReorder={reorderTabByGap}
              onToggleSidebar={toggleSidebar}
              onToggleGitPanel={toggleRightPanel}
              onScreenshot={startScreenshot}
              changedCount={sourceControl.changedCount}
              onOpenCommandPalette={() => openCommandPalette("commands")}
              onOpenSettings={() => void openSettingsWindow()}
              searchTarget={searchTarget}
              searchRef={searchInlineRef}
              onOverrideLanguage={setOverrideLanguage}
            />
          )}

          <main className="zoom-content flex min-h-0 flex-1 flex-col">
            <ResizablePanelGroup
              orientation="horizontal"
              className="min-h-0 flex-1"
              onLayoutChanged={(_, { isUserInteraction }) => {
                const width = sidebarRef.current?.getSize().inPixels ?? 0;
                persistSidebarWidth(width, isUserInteraction);
                const rightWidth =
                  rightPanelRef.current?.getSize().inPixels ?? 0;
                persistRightWidth(rightWidth, isUserInteraction);
              }}
            >
              <ResizablePanel
                id="sidebar"
                panelRef={sidebarRef}
                defaultSize={
                  initialSidebarCollapsed
                    ? "0px"
                    : `${sidebarWidthRef.current}px`
                }
                minSize={`${SIDEBAR_MIN_WIDTH}px`}
                maxSize={`${SIDEBAR_MAX_WIDTH}px`}
                collapsible
                collapsedSize={0}
                onResize={(size) => {
                  persistSidebarCollapsed(size.inPixels <= 0);
                }}
              >
                <div className="h-full min-h-0 pl-2 pr-0.5">
                  <div className="verta-pane flex h-full min-h-0 flex-col">
                    <div
                      key={sidebarView}
                      className="min-h-0 flex-1 verta-panel-in"
                    >
                      {sidebarView === "launcher" ? (
                        <LauncherPanel
                          activeSessionId={activeSessionId}
                          onOpenSession={handleOpenSession}
                          workspaceRoot={explorerRoot}
                        />
                      ) : sidebarView === "explorer" ? (
                        <FileExplorer
                          ref={explorerRef}
                          rootPath={explorerRoot}
                          gitStatus={
                            explorerGitDecorations ? sourceControl.status : null
                          }
                          activeFilePath={explorerActiveFilePath}
                          onOpenFile={handleOpenFile}
                          onPathRenamed={handleExplorerPathRenamed}
                          onPathsDeleted={handlePathsDeleted}
                          canReplacePath={canReplaceExplorerPath}
                          onRevealInTerminal={cdInNewTab}
                          onOpenInSourceControl={
                            handleOpenRepositoryInSourceControl
                          }
                          onOpenGitHistory={handleOpenGitHistoryForPath}
                          pathDropTarget={terminalPathDropTarget}
                          visible={!sidebarCollapsed}
                        />
                      ) : null}
                    </div>
                    <SidebarRail
                      activeView={sidebarView}
                      onSelectView={persistSidebarView}
                    />
                  </div>
                </div>
              </ResizablePanel>
              <ResizableHandle className="w-1 rounded-full bg-transparent transition-colors duration-[var(--dur-fast)] after:w-4 hover:bg-border" />
              <ResizablePanel id="workspace" defaultSize="78%" minSize="30%">
                {/* Both seams share the same padding (0.5 each) so sidebar↔terminal
                    and terminal↔Git look equally wide; the outer window margins
                    still come from the sidebar's pl-2 and the right panel's pr-2. */}
                <div className="h-full min-h-0 pl-0.5 pr-0.5">
                  <div className="verta-pane flex h-full min-h-0 flex-col">
                    <div className="relative min-h-0 flex-1">
                      <WorkspaceSurface
                        tabs={tabs}
                        activeId={activeId}
                        activeTab={activeTab}
                        registerTerminalHandle={registerTerminalHandle}
                        onSearchReady={handleSearchReady}
                        onCwd={handleTerminalCwd}
                        onExit={handleLeafExit}
                        onFocusLeaf={handleFocusLeaf}
                        registerEditorHandle={registerEditorHandle}
                        onEditorDirtyChange={handleEditorDirty}
                        onEditorCloseTab={disposeTab}
                        registerPreviewHandle={registerPreviewHandle}
                        onPreviewUrlChange={handlePreviewUrl}
                        onOpenCommitFile={openCommitFileDiffTab}
                        onGitHistorySearchHandle={setGitHistoryHandle}
                        onSetMarkdownView={setMarkdownView}
                        onOpenProject={handleOpenProject}
                        onOpenProjectSession={handleOpenSession}
                        onOpenProjectTerminal={handleOpenProjectTerminal}
                        onNewProjectSession={handleNewProjectSession}
                        sessionOpening={sessionOpening}
                      />
                    </div>

                    <WorkspaceInputBar
                      isBlockTab={isBlockTab}
                      isTerminalTab={isTerminalTab}
                      activeLeafId={activeLeafId}
                      cwd={activeCwd}
                      home={home}
                    />
                  </div>
                </div>
              </ResizablePanel>
              <ResizableHandle className="w-1 rounded-full bg-transparent transition-colors duration-[var(--dur-fast)] after:w-4 hover:bg-border" />
              <ResizablePanel
                id="gitPanel"
                panelRef={rightPanelRef}
                defaultSize={
                  initialRightCollapsed ? "0px" : `${rightWidthRef.current}px`
                }
                minSize={`${RIGHT_MIN_WIDTH}px`}
                maxSize={`${RIGHT_MAX_WIDTH}px`}
                collapsible
                collapsedSize={0}
                onResize={(size) => {
                  persistRightCollapsed(size.inPixels <= 0);
                }}
              >
                <div className="h-full min-h-0 pl-0.5 pr-2">
                  <div className="verta-pane flex h-full min-h-0 flex-col">
                    <div className="min-h-0 flex-1 verta-panel-in">
                      <SourceControlPanel
                        open
                        sourceControl={sourceControl}
                        onOpenDiff={openGitDiffTab}
                        onOpenGitGraph={openGitGraphFromContext}
                        onOpenFile={handleOpenFile}
                        onNavigateToPath={cdInNewTab}
                        repositoryTarget={sourceControlRepositoryTarget}
                        onFollowRepositoryContext={
                          handleFollowRepositoryContext
                        }
                      />
                    </div>
                  </div>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </main>

          {!zenMode && (
            <StatusBar
              cwd={activeCwd}
              filePath={activeFilePath}
              home={home}
              onCd={sendCd}
              privateActive={
                activeTab?.kind === "terminal" && activeTab.private === true
              }
            />
          )}

          <WindowVibrancyBridge />
          {IS_MAC ? <LivePageResizeBridge /> : null}
          <WindowActivityBridge
            bindFocus={bindTerminalWindowFocus}
            subscribePresentation={subscribeWindowPresentation}
          />

          <Toaster position="bottom-right" />

          {switcherState && (
            <TabSwitcherHud tabs={tabs} state={switcherState} />
          )}

          <CommandPalette
            open={commandPaletteOpen}
            onOpenChange={setCommandPaletteOpen}
            initialMode={paletteInitialMode}
            commandItems={commandPaletteItems}
            workspaceRoot={explorerRoot}
            onOpenContentHit={openContentHit}
            insertCommand={insertHistoryCommand}
          />

          <NewEditorDialog
            open={newEditorOpen}
            onOpenChange={setNewEditorOpen}
            rootPath={explorerRoot ?? home}
            onCreated={(path) => openFileTab(path)}
          />

          <UpdaterDialog />

          <CloseDialogs
            tabs={tabs}
            pendingCloseTab={pendingCloseTab}
            onCancelClose={cancelClose}
            onConfirmClose={confirmClose}
            pendingTerminalCloseTab={pendingTerminalCloseTab}
            onCancelTerminalClose={cancelTerminalClose}
            onConfirmTerminalClose={confirmTerminalClose}
            pendingDeleteTabs={pendingDeleteTabs}
            onCancelDeleteClose={cancelDeleteClose}
            onConfirmDeleteClose={confirmDeleteClose}
            pendingCloseMany={pendingCloseMany}
            closeManyConfirming={closeManyConfirming}
            onCancelCloseMany={cancelCloseMany}
            onConfirmCloseMany={confirmCloseMany}
            pendingAppClose={pendingAppClose}
            onCancelAppClose={cancelAppClose}
            onConfirmAppClose={confirmAppClose}
          />
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );

  return (
    <RunCommandProvider value={runInActiveTerminal}>{shell}</RunCommandProvider>
  );
}
