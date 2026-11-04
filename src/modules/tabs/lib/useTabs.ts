import { isMarkdownPath } from "@/lib/utils";
import { type PaneCount, createPanePlan } from "./panePlan";
import { useT } from "@/modules/i18n";
import type { AgentTool } from "@/modules/launcher/lib/types";
import type { WorkspaceEnv } from "@/modules/workspace";
import {
  findLeafCwd,
  hasLeaf,
  leafIds,
  nextLeafId,
  type PaneBounds,
  type PaneDirection,
  type PaneNode,
  removeLeaf,
  type SplitDir,
  setLeafCwd as setLeafCwdInTree,
  siblingLeafOf,
  splitLeaf,
  swapLeafInDirection,
} from "@/modules/terminal/lib/panes";
import { disposeSession } from "@/modules/terminal/lib/terminalSessionApi";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

// Matches the renderer slot pool size: over this we'd evict an active leaf.
export const MAX_PANES_PER_TAB = 4;

type TabBase = {
  /** Restored from disk, not yet activated: rendered as a placeholder, not mounted. */
  cold?: boolean;
};

export type TerminalTab = TabBase & {
  id: number;
  kind: "terminal";
  title: string;
  cwd?: string;
  paneTree: PaneNode;
  activeLeafId: number;
  blocks?: boolean;
  /** AI agent cannot read buffer / context of this terminal. */
  private?: boolean;
  /** User-set label that overrides the cwd-derived name. Survives cd. */
  customTitle?: string;
  /**
   * Agent this tab was opened for (a resumed session, or a project row's
   * "open with"). Only used to pick the tab's mark: it is the agent the tab
   * started with, not a statement about what runs in it now.
   */
  agent?: AgentTool;
  /**
   * The stored session this tab resumed, when it was opened from the session
   * list. It is what lets that list mark a row with the state of the session
   * running behind it; a tab opened any other way has nothing to point at.
   */
  sessionId?: string;
  /**
   * Restored from disk with a session attached but not resumed yet: the first
   * activation runs the session's resume command. Transient - never serialized,
   * and cleared once the resume has run or been refused.
   */
  pendingResume?: boolean;
};

export type EditorTab = TabBase & {
  id: number;
  kind: "editor";
  title: string;
  path: string;
  dirty: boolean;
  /**
   * True while the tab is in the transient "preview" state, opened by a
   * single-click in the explorer and not yet pinned by the user. A preview tab
   * is replaced by the next single-click rather than accumulating.
   */
  preview: boolean;
  /**
   * The path this file had before the explorer renamed or moved it.
   *
   * Set by the rename handler and read by the editor, which has to carry its buffer, its unsaved
   * flag and its saved baseline over to the new path rather than opening the new name as a fresh
   * document. Absent for every other way a tab's path can change.
   */
  renamedFrom?: string;
  overrideLanguage?: string | null;
};

export type PreviewTab = TabBase & {
  id: number;
  kind: "preview";
  title: string;
  url: string;
};

export type MarkdownTab = TabBase & {
  id: number;
  kind: "markdown";
  title: string;
  path: string;
};

export type GitDiffTab = TabBase & {
  id: number;
  kind: "git-diff";
  title: string;
  path: string;
  repoRoot: string;
  mode: "-" | "+";
  originalPath: string | null;
  preview: boolean;
};

export type GitHistoryTab = TabBase & {
  id: number;
  kind: "git-history";
  title: string;
  repoRoot: string;
};

/**
 * The projects panel: the local project list and the remote repository list behind one
 * tab, switched by a tab strip inside it. Only one is ever open, and it carries no
 * state beyond the title, which names the list currently on screen.
 */
export type ProjectsTab = TabBase & {
  id: number;
  kind: "projects";
  title: string;
};

/**
 * Notes: a list on the left and one editor on the right, over the markdown files in the
 * app's own `notes\` folder. Only one is ever open. `root` is the folder this tab was
 * opened against (it can move between a dev build and an installed one), and `activePath`
 * is the note on the right - null when nothing is picked, or there is none yet.
 */
export type NotesTab = TabBase & {
  id: number;
  kind: "notes";
  title: string;
  root: string;
  activePath: string | null;
  /** Unsaved keystrokes in the note on the right. */
  dirty?: boolean;
};

export type GitCommitFileDiffTab = TabBase & {
  id: number;
  kind: "git-commit-file";
  title: string;
  repoRoot: string;
  sha: string;
  shortSha: string;
  subject: string;
  path: string;
  originalPath: string | null;
};

export type Tab =
  | TerminalTab
  | EditorTab
  | PreviewTab
  | MarkdownTab
  | GitDiffTab
  | GitHistoryTab
  | ProjectsTab
  | NotesTab
  | GitCommitFileDiffTab;

export type TabPatch = Partial<{
  title: string;
  cwd: string;
  path: string;
  dirty: boolean;
  url: string;
  /** Empty string resets a terminal tab to its cwd-derived name. */
  customTitle: string;
  overrideLanguage: string | null;
  /** The path an editor tab's file had before it was renamed or moved. */
  renamedFrom: string;
  /** The note a notes tab has on its right; null puts the placeholder back. */
  activePath: string | null;
  /** The notes folder a notes tab reads, when it moves with the executable. */
  root: string;
}>;

export type GitDiffOpenInput = {
  path: string;
  repoRoot: string;
  mode: "-" | "+";
  originalPath?: string | null;
  title?: string;
};

export type OpenFileTabOptions = {
  activate?: boolean;
};

export type CloseTabsPlan = {
  closeIds: number[];
  nextActiveId: number;
};

type CloseTabsPlanResult = {
  tabs: Tab[];
  closeIds: number[];
  disposeLeafIds: number[];
  nextActiveId: number;
};

export function planMarkdownTabOpen(
  tabs: Tab[],
  path: string,
  allocId: () => number,
): { tabs: Tab[]; tabId: number } {
  const pathKey = path.replace(/\\/g, "/");
  const existing = tabs.find(
    (tab) =>
      tab.kind === "markdown" && tab.path.replace(/\\/g, "/") === pathKey,
  );
  if (existing) return { tabs, tabId: existing.id };

  const tabId = allocId();
  return {
    tabs: [
      ...tabs,
      {
        id: tabId,
        kind: "markdown",
        title: basename(path),
        path,
      },
    ],
    tabId,
  };
}

export function planFileTabOpen(
  tabs: Tab[],
  path: string,
  pin: boolean,
  allocId: () => number,
): { tabs: Tab[]; tabId: number } {
  if (pin) {
    const existing = tabs.find(
      (tab) => tab.kind === "editor" && tab.path === path,
    );
    if (existing?.kind === "editor") {
      return {
        tabs: existing.preview
          ? tabs.map((tab) =>
              tab.id === existing.id ? { ...tab, preview: false } : tab,
            )
          : tabs,
        tabId: existing.id,
      };
    }

    const tabId = allocId();
    return {
      tabs: [
        ...tabs,
        {
          id: tabId,
          kind: "editor",
          title: basename(path),
          path,
          dirty: false,
          preview: false,
        },
      ],
      tabId,
    };
  }

  const persistent = tabs.find(
    (tab) => tab.kind === "editor" && tab.path === path && !tab.preview,
  );
  if (persistent) return { tabs, tabId: persistent.id };

  const existingPreview = tabs.find(
    (tab) => tab.kind === "editor" && tab.path === path && tab.preview,
  );
  if (existingPreview) return { tabs, tabId: existingPreview.id };

  const previewIndex = tabs.findIndex(
    (tab) => tab.kind === "editor" && tab.preview,
  );
  const tabId = allocId();
  const tab: EditorTab = {
    id: tabId,
    kind: "editor",
    title: basename(path),
    path,
    dirty: false,
    preview: true,
  };
  if (previewIndex === -1) return { tabs: [...tabs, tab], tabId };

  const next = [...tabs];
  next[previewIndex] = tab;
  return { tabs: next, tabId };
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function titleFromUrl(url: string, fallback: string): string {
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url || fallback;
  }
}

/** The tab a patch would produce, with no decision about identity yet. */
function patchedTab(x: Tab, patch: TabPatch, previewLabel: string): Tab {
  if (x.kind === "terminal") {
    return {
      ...x,
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.cwd !== undefined && { cwd: patch.cwd }),
      ...(patch.customTitle !== undefined && {
        customTitle: patch.customTitle === "" ? undefined : patch.customTitle,
      }),
    };
  }
  if (x.kind === "preview") {
    return {
      ...x,
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.url !== undefined && {
        url: patch.url,
        title: patch.title ?? titleFromUrl(patch.url, previewLabel),
      }),
    };
  }
  if (x.kind === "markdown") {
    return {
      ...x,
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.path !== undefined && { path: patch.path }),
    };
  }
  if (x.kind === "notes") {
    return {
      ...x,
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.activePath !== undefined && { activePath: patch.activePath }),
      ...(patch.dirty !== undefined && { dirty: patch.dirty }),
      ...(patch.root !== undefined && { root: patch.root }),
    };
  }
  // editor tab: auto-promote from preview the moment the file becomes dirty.
  const autoPin =
    patch.dirty === true && (x as EditorTab).preview ? { preview: false } : {};
  return {
    ...x,
    ...autoPin,
    ...(patch.title !== undefined && { title: patch.title }),
    ...(patch.dirty !== undefined && { dirty: patch.dirty }),
    ...(patch.path !== undefined && { path: patch.path }),
    ...(patch.renamedFrom !== undefined && { renamedFrom: patch.renamedFrom }),
    ...(patch.overrideLanguage !== undefined && {
      overrideLanguage: patch.overrideLanguage,
    }),
  };
}

/** The fields a patch can touch, which are the ones worth comparing for identity. */
const PATCHED_FIELDS = [
  "title",
  "cwd",
  "customTitle",
  "url",
  "dirty",
  "path",
  "renamedFrom",
  "overrideLanguage",
  "preview",
  "activePath",
  "root",
] as const;

/**
 * Apply a patch to one tab, or hand the same tab back when the patch changes nothing.
 *
 * The tab list is what the whole window renders from, so a call that changes nothing must not
 * produce a new array: React re-renders on identity, and a pane reporting the same title, the same
 * path or the same unsaved flag as before would re-render every open tab along with it. Same rule as
 * `setLeafCwd`, which carries the same reason.
 */
export function applyTabPatch(
  tab: Tab,
  patch: TabPatch,
  previewLabel: string,
): Tab {
  const next = patchedTab(tab, patch, previewLabel);
  for (const field of PATCHED_FIELDS) {
    if (
      (next as Record<string, unknown>)[field] !==
      (tab as Record<string, unknown>)[field]
    ) {
      return next;
    }
  }
  return tab;
}

// Next active after close. null = the closing tab is the last one, which
// callers treat as "refuse to close".
export function nextActiveTab(tabs: Tab[], closingId: number): number | null {
  if (!tabs.some((t) => t.id === closingId)) return null;
  if (tabs.length <= 1) return null;
  const idx = tabs.findIndex((t) => t.id === closingId);
  return (tabs[idx - 1] ?? tabs[idx + 1]).id;
}

// Gap index is relative to the strip, including the dragged tab.
export function reorderTabsByGap(
  tabs: Tab[],
  fromId: number,
  toGapIndex: number,
): Tab[] {
  const from = tabs.findIndex((t) => t.id === fromId);
  if (from === -1) return tabs;
  let target = toGapIndex > from ? toGapIndex - 1 : toGapIndex;
  target = Math.max(0, Math.min(target, tabs.length - 1));
  if (target === from) return tabs;
  const moved = tabs[from];
  const anchor = tabs[target];
  const next = tabs.filter((t) => t.id !== fromId);
  const anchorIdx = next.findIndex((t) => t.id === anchor.id);
  const insertIdx = target > from ? anchorIdx + 1 : anchorIdx;
  next.splice(insertIdx, 0, moved);
  return next;
}

/**
 * Plans a Chrome-style "close tabs to the right".
 * Returns the ids strictly to the right of the anchor plus the id to keep
 * active: the anchor when the active tab is being closed, unchanged otherwise.
 */
export function planCloseTabsToRight(
  tabs: Tab[],
  anchorId: number,
  activeId: number,
): CloseTabsPlan {
  const idx = tabs.findIndex((t) => t.id === anchorId);
  if (idx === -1) return { closeIds: [], nextActiveId: activeId };
  const closeIds = tabs.slice(idx + 1).map((t) => t.id);
  if (closeIds.length === 0) return { closeIds, nextActiveId: activeId };
  return {
    closeIds,
    nextActiveId: closeIds.includes(activeId) ? anchorId : activeId,
  };
}

/**
 * Plans a Chrome-style "close other tabs".
 * Returns every other tab's id plus the id to keep active: the anchor when the
 * active tab is being closed, unchanged otherwise.
 */
export function planCloseOtherTabs(
  tabs: Tab[],
  anchorId: number,
  activeId: number,
): CloseTabsPlan {
  if (!tabs.some((t) => t.id === anchorId))
    return { closeIds: [], nextActiveId: activeId };
  const closeIds = tabs.filter((t) => t.id !== anchorId).map((t) => t.id);
  if (closeIds.length === 0) return { closeIds, nextActiveId: activeId };
  return {
    closeIds,
    nextActiveId: closeIds.includes(activeId) ? anchorId : activeId,
  };
}

export function applyCloseTabsPlan(
  tabs: Tab[],
  anchorId: number,
  plan: CloseTabsPlan,
): CloseTabsPlanResult | null {
  const anchor = tabs.find((tab) => tab.id === anchorId);
  if (!anchor) return null;

  const requested = new Set(plan.closeIds);
  const closing = tabs.filter(
    (tab) => tab.id !== anchorId && requested.has(tab.id),
  );
  if (closing.length === 0) return null;

  const closeIds = closing.map((tab) => tab.id);
  const close = new Set(closeIds);
  const next = tabs.filter((tab) => !close.has(tab.id));
  const nextActiveId = next.some((tab) => tab.id === plan.nextActiveId)
    ? plan.nextActiveId
    : anchorId;
  const disposeLeafIds = closing
    .filter((tab) => tab.kind === "terminal")
    .flatMap((tab) => leafIds(tab.paneTree));

  return { tabs: next, closeIds, disposeLeafIds, nextActiveId };
}

export function planGitDiffOpen(
  tabs: Tab[],
  input: GitDiffOpenInput,
  pin: boolean,
  allocId: () => number,
): { tabs: Tab[]; targetId: number } {
  const title = input.title ?? `${basename(input.path)} (${input.mode})`;
  const originalPath = input.originalPath ?? null;
  const matches = (tab: Tab): tab is GitDiffTab =>
    tab.kind === "git-diff" &&
    tab.repoRoot === input.repoRoot &&
    tab.path === input.path &&
    tab.mode === input.mode;
  const matchingTabs = tabs.filter(matches);
  const existing = matchingTabs.find((tab) => !tab.preview) ?? matchingTabs[0];

  if (existing) {
    const preview = pin ? false : existing.preview;
    if (
      existing.title === title &&
      existing.originalPath === originalPath &&
      existing.preview === preview
    ) {
      return { tabs, targetId: existing.id };
    }
    return {
      tabs: tabs.map((tab) =>
        tab.id === existing.id
          ? { ...existing, title, originalPath, preview }
          : tab,
      ),
      targetId: existing.id,
    };
  }

  const id = allocId();
  const tab = {
    id,
    kind: "git-diff",
    title,
    path: input.path,
    repoRoot: input.repoRoot,
    mode: input.mode,
    originalPath,
    preview: !pin,
  } satisfies GitDiffTab;

  if (pin) return { tabs: [...tabs, tab], targetId: id };

  const previewIndex = tabs.findIndex(
    (candidate) => candidate.kind === "git-diff" && candidate.preview,
  );
  if (previewIndex === -1) return { tabs: [...tabs, tab], targetId: id };

  const next = [...tabs];
  next[previewIndex] = tab;
  return { tabs: next, targetId: id };
}

export function planCommitHistoryOpen(
  tabs: Tab[],
  input: { repoRoot: string; title: string },
  allocId: () => number,
): { tabs: Tab[]; targetId: number } {
  const existing = tabs.find(
    (tab) => tab.kind === "git-history" && tab.repoRoot === input.repoRoot,
  );
  const title = input.title;
  if (existing) {
    if (existing.title === title) return { tabs, targetId: existing.id };
    return {
      tabs: tabs.map((tab) =>
        tab.id === existing.id ? { ...existing, title } : tab,
      ),
      targetId: existing.id,
    };
  }

  const id = allocId();
  return {
    tabs: [
      ...tabs,
      {
        id,
        kind: "git-history",
        title,
        repoRoot: input.repoRoot,
      } satisfies GitHistoryTab,
    ],
    targetId: id,
  };
}

/**
 * Projects panel: only one. The lists are shared app-wide, so a single tab is enough.
 */
export function planProjectsOpen(
  tabs: Tab[],
  title: string,
  allocId: () => number,
): { tabs: Tab[]; targetId: number } {
  const existing = tabs.find((tab) => tab.kind === "projects");
  if (existing) {
    if (existing.title === title) return { tabs, targetId: existing.id };
    return {
      tabs: tabs.map((tab) =>
        tab.id === existing.id ? { ...existing, title } : tab,
      ),
      targetId: existing.id,
    };
  }

  const id = allocId();
  return {
    tabs: [...tabs, { id, kind: "projects", title } satisfies ProjectsTab],
    targetId: id,
  };
}

/**
 * Notes: only one. The list and the editor live inside the tab, so a second entry in the
 * strip would be a second copy of the same folder. A root that differs from the one the
 * open tab carries (a dev build next to an installed one) is adopted, not opened twice.
 */
export function planNotesTabOpen(
  tabs: Tab[],
  title: string,
  root: string,
  allocId: () => number,
): { tabs: Tab[]; targetId: number } {
  const existing = tabs.find((tab) => tab.kind === "notes");
  if (existing) {
    if (existing.root === root) return { tabs, targetId: existing.id };
    // The folder moved with the executable: the note picked in the old one is not a
    // file of the new one, so the placeholder comes back.
    return {
      tabs: tabs.map((tab) =>
        tab.id === existing.id ? { ...existing, root, activePath: null } : tab,
      ),
      targetId: existing.id,
    };
  }

  const id = allocId();
  return {
    tabs: [
      ...tabs,
      { id, kind: "notes", title, root, activePath: null } satisfies NotesTab,
    ],
    targetId: id,
  };
}

export function useTabs(initial?: Partial<TerminalTab>) {
  const t = useT();
  // The names a tab falls back to when there is nothing better to show: a
  // terminal with no cwd, a command-blocks terminal, a preview with no url.
  // Resolved to strings here so the callbacks below can depend on the string
  // (and so `setTabs((t) => ...)` cannot shadow the lookup).
  const shellLabel = t("tabs.shell");
  const blocksLabel = t("tabs.blocks");
  const previewLabel = t("tabs.preview");
  const [tabs, setTabs] = useState<Tab[]>(() => {
    const tabId = 1;
    const leafId = 2;
    return [
      {
        id: tabId,
        kind: "terminal",
        cold: true,
        title: initial?.title ?? shellLabel,
        cwd: initial?.cwd,
        paneTree: { kind: "leaf", id: leafId, cwd: initial?.cwd },
        activeLeafId: leafId,
      },
    ];
  });
  const [activeId, setActiveId] = useState(1);
  // Gates warming until boot resolves the restore, so no shell spawns before it.
  const [booted, setBooted] = useState(false);
  const nextIdRef = useRef(3);
  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);

  useLayoutEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useLayoutEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // Activating a cold tab warms it: one choke point for every activation path.
  useEffect(() => {
    if (!booted) return;
    setTabs((curr) => {
      const t = curr.find((x) => x.id === activeId);
      if (!t?.cold) return curr;
      return curr.map((x) => (x.id === activeId ? { ...x, cold: false } : x));
    });
  }, [activeId, booted]);

  const allocId = useCallback(() => nextIdRef.current++, []);

  const markBooted = useCallback(() => setBooted(true), []);

  const replaceTabs = useCallback((next: Tab[], nextActiveId: number) => {
    if (next.length === 0) return;
    tabsRef.current = next;
    activeIdRef.current = nextActiveId;
    setTabs(next);
    setActiveId(nextActiveId);
  }, []);

  /**
   * A restored session tab has been dealt with: drop the resume marker, and drop the
   * session with it when the resume could not be done, so the session list stops
   * pointing at a tab that will never run it.
   */
  const clearResumeIntent = useCallback(
    (tabId: number, dropSessionId: boolean) => {
      setTabs((curr) => {
        let changed = false;
        const next = curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          if (!t.pendingResume && !(dropSessionId && t.sessionId)) return t;
          changed = true;
          const rest: TerminalTab = { ...t };
          delete rest.pendingResume;
          if (dropSessionId) delete rest.sessionId;
          return rest;
        });
        return changed ? next : curr;
      });
    },
    [],
  );

  const newTab = useCallback(
    (cwd?: string, options?: { workspace?: WorkspaceEnv; shell?: string }) => {
      const tabId = nextIdRef.current++;
      const leafId = nextIdRef.current++;
      setTabs((t) => [
        ...t,
        {
          id: tabId,
          kind: "terminal",
          title: shellLabel,
          cwd,
          paneTree: {
            kind: "leaf",
            id: leafId,
            cwd,
            workspace: options?.workspace,
            shell: options?.shell,
          },
          activeLeafId: leafId,
        },
      ]);
      setActiveId(tabId);
      return tabId;
    },
    [shellLabel],
  );

  const newBlockTab = useCallback((cwd?: string) => {
    const tabId = nextIdRef.current++;
    const leafId = nextIdRef.current++;
    setTabs((t) => [
      ...t,
      {
        id: tabId,
        kind: "terminal",
        title: blocksLabel,
        cwd,
        paneTree: { kind: "leaf", id: leafId, cwd },
        activeLeafId: leafId,
        blocks: true,
      },
    ]);
    setActiveId(tabId);
    return tabId;
  }, [blocksLabel]);

  useEffect(() => {
    if (!import.meta.env?.DEV || typeof window === "undefined") return;
    (
      window as unknown as { __vertaNewBlockTab?: (cwd?: string) => number }
    ).__vertaNewBlockTab = newBlockTab;
  }, [newBlockTab]);

  const newAgentGroupTab = useCallback(
    (
      cwd: string | undefined,
      title: string,
      instances: PaneCount,
      workspace?: WorkspaceEnv,
      agent?: AgentTool,
      sessionId?: string,
    ) => {
      const tabId = nextIdRef.current++;
      const { paneTree, leafIds: agentLeafIds } = createPanePlan(
        instances,
        () => nextIdRef.current++,
        cwd,
        workspace,
      );
      setTabs((t) => [
        ...t,
        {
          id: tabId,
          kind: "terminal",
          title,
          customTitle: title,
          cwd,
          paneTree,
          activeLeafId: agentLeafIds[0],
          ...(agent !== undefined && { agent }),
          ...(sessionId !== undefined && { sessionId }),
        },
      ]);
      setActiveId(tabId);
      return { tabId, leafIds: agentLeafIds };
    },
    [],
  );

  const newAgentTab = useCallback(
    (
      cwd: string | undefined,
      title: string,
      workspace?: WorkspaceEnv,
      agent?: AgentTool,
      sessionId?: string,
    ) => {
      const { tabId, leafIds: agentLeafIds } = newAgentGroupTab(
        cwd,
        title,
        1,
        workspace,
        agent,
        sessionId,
      );
      return { tabId, leafId: agentLeafIds[0] };
    },
    [newAgentGroupTab],
  );

  useEffect(() => {
    if (!import.meta.env?.DEV || typeof window === "undefined") return;
    // A probe needs a tab whose icon is an agent's *without* an agent being started on it: the state
    // marker only shows on such a tab (see `lib/tabAgentIcon.ts`), and the screens that decide what
    // the marker says have to be the probe's own. `newAgentTab` is the app's own path for that tab;
    // nothing else in the app reads this.
    (
      window as unknown as {
        __vertaNewAgentTab?: (
          cwd: string | undefined,
          title: string,
          agent: AgentTool,
        ) => { tabId: number; leafId: number };
      }
    ).__vertaNewAgentTab = (cwd, title, agent) =>
      newAgentTab(cwd, title, undefined, agent);
  }, [newAgentTab]);

  const newPrivateTab = useCallback((cwd?: string) => {
    const tabId = nextIdRef.current++;
    const leafId = nextIdRef.current++;
    setTabs((t) => [
      ...t,
      {
        id: tabId,
        kind: "terminal",
        title: "private",
        cwd,
        paneTree: { kind: "leaf", id: leafId, cwd },
        activeLeafId: leafId,
        private: true,
      },
    ]);
    setActiveId(tabId);
    return tabId;
  }, []);

  /**
   * Opens a file in an editor tab.
   *
   * - `pin = true` (default): opens or activates a **persistent** tab.
   *   If the path is currently in the preview slot it is promoted in-place.
   *   Use this for programmatic opens (AI diff, New File dialog, etc.).
   * - `pin = false`: VSCode-style **preview** tab. A single shared slot is
   *   reused: if a persistent tab for the path already exists it is activated;
   *   otherwise the current preview slot is replaced with the new path.
   */
  const openFileTab = useCallback(
    (path: string, pin = true, options: OpenFileTabOptions = {}) => {
      const activate = options.activate ?? true;
      const plan = planFileTabOpen(
        tabsRef.current,
        path,
        pin,
        () => nextIdRef.current++,
      );
      tabsRef.current = plan.tabs;
      setTabs(plan.tabs);
      if (activate) setActiveId(plan.tabId);
      return plan.tabId;
    },
    [],
  );

  /**
   * Promotes a preview tab to a persistent one. Called on double-click of the
   * tab title in the tab bar. Dirty editor tabs also auto-promote.
   */
  const pinTab = useCallback((id: number) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.id !== id) return t;
        if ((t.kind === "editor" || t.kind === "git-diff") && t.preview) {
          return { ...t, preview: false };
        }
        return t;
      }),
    );
  }, []);

  const newPreviewTab = useCallback((url: string) => {
    const id = nextIdRef.current++;
    setTabs((t) => [
      ...t,
      {
        id,
        kind: "preview",
        title: titleFromUrl(url, previewLabel),
        url,
      },
    ]);
    setActiveId(id);
    return id;
  }, [previewLabel]);

  // Mirrors tabsRef like openFileTab instead of using a functional update: a
  // batch that opens a markdown file before a regular one (multi-file "Open
  // With") would otherwise have the queued markdown update clobbered by
  // openFileTab's setTabs(plan.tabs), which is built from the stale ref.
  const newMarkdownTab = useCallback((path: string) => {
    const curr = tabsRef.current;
    const plan = planMarkdownTabOpen(curr, path, () => nextIdRef.current++);
    if (plan.tabs !== curr) {
      tabsRef.current = plan.tabs;
      setTabs(plan.tabs);
    }
    setActiveId(plan.tabId);
    return plan.tabId;
  }, []);

  const setOverrideLanguage = useCallback((id: number, lang: string | null) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.id !== id || t.kind !== "editor") return t;
        return {
          ...t,
          overrideLanguage: lang,
        };
      }),
    );
  }, []);

  const setMarkdownView = useCallback(
    (id: number, mode: "rendered" | "raw") => {
      setTabs((curr) =>
        curr.map((t) => {
          if (
            t.id !== id ||
            !isMarkdownPath((t as { path?: string }).path ?? "")
          )
            return t;
          if (mode === "raw" && t.kind === "markdown") {
            return {
              ...t,
              kind: "editor" as const,
              dirty: false,
              preview: false,
              overrideLanguage:
                (t as { overrideLanguage?: string | null }).overrideLanguage ??
                null,
            };
          }
          if (mode === "rendered" && t.kind === "editor") {
            if (t.dirty) return t;
            return {
              id: t.id,
              kind: "markdown" as const,
              cold: t.cold,
              title: t.title,
              path: t.path,
              overrideLanguage: t.overrideLanguage ?? null,
            };
          }
          return t;
        }),
      );
    },
    [],
  );

  const openGitDiffTab = useCallback((input: GitDiffOpenInput, pin = false) => {
    const curr = tabsRef.current;
    const plan = planGitDiffOpen(curr, input, pin, () => nextIdRef.current++);
    if (plan.tabs !== curr) {
      tabsRef.current = plan.tabs;
      setTabs(plan.tabs);
    }
    setActiveId(plan.targetId);
    return plan.targetId;
  }, []);

  const openCommitHistoryTab = useCallback(
    (input: { repoRoot: string; branch?: string | null }) => {
      const curr = tabsRef.current;
      // The label is built here rather than in the planner: it depends on the
      // language, and the planner stays a pure function over tabs.
      const title = input.branch
        ? t("gitHistory.tabTitle", { branch: input.branch })
        : t("gitHistory.tabTitlePlain");
      const plan = planCommitHistoryOpen(
        curr,
        { repoRoot: input.repoRoot, title },
        () => nextIdRef.current++,
      );
      if (plan.tabs !== curr) {
        tabsRef.current = plan.tabs;
        setTabs(plan.tabs);
      }
      setActiveId(plan.targetId);
      return plan.targetId;
    },
    [t],
  );

  /** Open the projects tab; only one. */
  /** Open the projects panel; only one. */
  const openProjectsTab = useCallback((title: string) => {
    const curr = tabsRef.current;
    const plan = planProjectsOpen(curr, title, () => nextIdRef.current++);
    if (plan.tabs !== curr) {
      tabsRef.current = plan.tabs;
      setTabs(plan.tabs);
    }
    setActiveId(plan.targetId);
    return plan.targetId;
  }, []);

  /** Open the notes tab; only one. */
  const openNotesTab = useCallback((title: string, root: string) => {
    const curr = tabsRef.current;
    const plan = planNotesTabOpen(curr, title, root, () => nextIdRef.current++);
    if (plan.tabs !== curr) {
      tabsRef.current = plan.tabs;
      setTabs(plan.tabs);
    }
    setActiveId(plan.targetId);
    return plan.targetId;
  }, []);

  /**
   * Rename the projects panel, if it is open. The panel calls this as its own tab strip
   * moves, so the tab chip and the window title name the list on screen rather than
   * whichever list happened to open it.
   */
  const renameProjectsTab = useCallback((title: string) => {
    setTabs((curr) =>
      curr.map((tab) =>
        tab.kind === "projects" && tab.title !== title
          ? { ...tab, title }
          : tab,
      ),
    );
  }, []);

  const openCommitFileDiffTab = useCallback(
    (input: {
      repoRoot: string;
      sha: string;
      shortSha: string;
      subject: string;
      path: string;
      originalPath: string | null;
    }) => {
      const curr = tabsRef.current;
      const existing = curr.find(
        (t) =>
          t.kind === "git-commit-file" &&
          t.repoRoot === input.repoRoot &&
          t.sha === input.sha &&
          t.path === input.path,
      );
      const title = `${basename(input.path)} @ ${input.shortSha}`;
      if (existing) {
        const nextTabs = curr.map((t) =>
          t.id === existing.id
            ? {
                ...t,
                title,
                subject: input.subject,
                originalPath: input.originalPath,
              }
            : t,
        );
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        setActiveId(existing.id);
        return existing.id;
      }
      const id = nextIdRef.current++;
      const nextTabs = [
        ...curr,
        {
          id,
          kind: "git-commit-file",
          title,
          repoRoot: input.repoRoot,
          sha: input.sha,
          shortSha: input.shortSha,
          subject: input.subject,
          path: input.path,
          originalPath: input.originalPath,
        } satisfies GitCommitFileDiffTab,
      ];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActiveId(id);
      return id;
    },
    [],
  );

  const closeTab = useCallback((id: number) => {
    let toDispose: number[] = [];
    setTabs((curr) => {
      const fallback = nextActiveTab(curr, id);
      if (fallback === null) return curr;
      const target = curr.find((t) => t.id === id);
      if (target?.kind === "terminal") {
        toDispose = leafIds(target.paneTree);
      }
      const next = curr.filter((t) => t.id !== id);
      setActiveId((active) => (id === active ? fallback : active));
      return next;
    });
    for (const lid of toDispose) disposeSession(lid);
  }, []);

  const closeTabs = useCallback(
    (anchorId: number, plan: CloseTabsPlan): number[] => {
      const result = applyCloseTabsPlan(tabsRef.current, anchorId, plan);
      if (!result) return [];
      tabsRef.current = result.tabs;
      activeIdRef.current = result.nextActiveId;
      setTabs(result.tabs);
      setActiveId(result.nextActiveId);
      for (const leafId of result.disposeLeafIds) disposeSession(leafId);
      return result.closeIds;
    },
    [],
  );

  const updateTab = useCallback(
    (id: number, patch: TabPatch) => {
      setTabs((tabs) => {
        let changed = false;
        const next = tabs.map((tab) => {
          if (tab.id !== id) return tab;
          const applied = applyTabPatch(tab, patch, previewLabel);
          if (applied !== tab) changed = true;
          return applied;
        });
        return changed ? next : tabs;
      });
    },
    [previewLabel],
  );

  const selectByIndex = useCallback(
    (idx: number) => {
      const t = tabs[idx];
      if (t) setActiveId(t.id);
    },
    [tabs],
  );

  /** Update a leaf's cwd; mirror to the tab's `cwd` when the leaf is active.
   * Bails out without setTabs when nothing actually changed: shell integration
   * re-emits OSC 7 on every prompt, including empty Enters, so this fires at
   * keystroke rate. Always-setTabs there cascades a paneTree re-render across
   * every open tab. */
  const setLeafCwd = useCallback((leafId: number, cwd: string) => {
    setTabs((curr) => {
      let changed = false;
      const next = curr.map((t) => {
        if (t.kind !== "terminal" || !hasLeaf(t.paneTree, leafId)) return t;
        const paneTree = setLeafCwdInTree(t.paneTree, leafId, cwd);
        const isActive = t.activeLeafId === leafId;
        const cwdChanged = isActive && t.cwd !== cwd;
        if (paneTree === t.paneTree && !cwdChanged) return t;
        changed = true;
        return { ...t, paneTree, ...(cwdChanged && { cwd }) };
      });
      return changed ? next : curr;
    });
  }, []);

  /** Focusing the pane that is already focused is not a change: see `updateTab` for why the array
   *  must keep its identity then. Clicking a pane that already has focus is routine, and a rebuilt
   *  array re-renders every open tab with it. */
  const focusPane = useCallback((tabId: number, leafId: number) => {
    setTabs((curr) => {
      let changed = false;
      const next = curr.map((t) => {
        if (t.id !== tabId || t.kind !== "terminal") return t;
        if (!hasLeaf(t.paneTree, leafId)) return t;
        if (t.activeLeafId === leafId) return t;
        changed = true;
        const cwd = findLeafCwd(t.paneTree, leafId);
        return {
          ...t,
          activeLeafId: leafId,
          ...(cwd !== undefined && { cwd }),
        };
      });
      return changed ? next : curr;
    });
  }, []);

  const focusNextPaneInTab = useCallback((tabId: number, delta: 1 | -1) => {
    setTabs((curr) => {
      let changed = false;
      const next = curr.map((t) => {
        if (t.id !== tabId || t.kind !== "terminal") return t;
        const nextLeaf = nextLeafId(t.paneTree, t.activeLeafId, delta);
        if (nextLeaf === t.activeLeafId) return t;
        changed = true;
        const cwd = findLeafCwd(t.paneTree, nextLeaf);
        return {
          ...t,
          activeLeafId: nextLeaf,
          ...(cwd !== undefined && { cwd }),
        };
      });
      return changed ? next : curr;
    });
  }, []);

  const swapActivePaneInDirection = useCallback(
    (tabId: number, direction: PaneDirection, bounds?: PaneBounds[]) => {
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          const paneTree = swapLeafInDirection(
            t.paneTree,
            t.activeLeafId,
            direction,
            bounds,
          );
          return paneTree === t.paneTree ? t : { ...t, paneTree };
        }),
      );
    },
    [],
  );

  /** Split the active leaf of `tabId` along `dir`. Returns the new leaf id. */
  const splitActivePane = useCallback(
    (tabId: number, dir: SplitDir): number | null => {
      let newLeafId: number | null = null;
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal" || t.blocks) return t;
          if (leafIds(t.paneTree).length >= MAX_PANES_PER_TAB) return t;
          const splitId = nextIdRef.current++;
          const leafId = nextIdRef.current++;
          newLeafId = leafId;
          const paneTree = splitLeaf(
            t.paneTree,
            t.activeLeafId,
            splitId,
            leafId,
            dir,
            t.cwd,
          );
          return { ...t, paneTree, activeLeafId: leafId };
        }),
      );
      return newLeafId;
    },
    [],
  );

  const closePaneByLeaf = useCallback((leafId: number): void => {
    let didRemove = false;
    setTabs((curr) => {
      const tab = curr.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
      );
      if (tab?.kind !== "terminal") return curr;
      const newTree = removeLeaf(tab.paneTree, leafId);
      if (newTree === null) {
        const fallback = nextActiveTab(curr, tab.id);
        if (fallback === null) return curr;
        const next = curr.filter((x) => x.id !== tab.id);
        setActiveId((active) => (active === tab.id ? fallback : active));
        didRemove = true;
        return next;
      }
      const remaining = leafIds(newTree);
      let newActive = tab.activeLeafId;
      if (tab.activeLeafId === leafId) {
        const sib = siblingLeafOf(tab.paneTree, leafId);
        newActive = sib && remaining.includes(sib) ? sib : remaining[0];
      }
      didRemove = true;
      return curr.map((x) =>
        x.id === tab.id
          ? { ...x, paneTree: newTree, activeLeafId: newActive }
          : x,
      );
    });
    if (didRemove) disposeSession(leafId);
  }, []);

  const closeActivePane = useCallback((tabId: number): boolean => {
    let closedTab = false;
    let removedLeaf: number | null = null;
    setTabs((curr) => {
      const t = curr.find((x) => x.id === tabId);
      if (t?.kind !== "terminal") return curr;
      const target = t.activeLeafId;
      const newTree = removeLeaf(t.paneTree, target);
      if (newTree === null) {
        const fallback = nextActiveTab(curr, tabId);
        if (fallback === null) return curr;
        const next = curr.filter((x) => x.id !== tabId);
        setActiveId((active) => (active === tabId ? fallback : active));
        closedTab = true;
        removedLeaf = target;
        return next;
      }
      const remaining = leafIds(newTree);
      const sib = siblingLeafOf(t.paneTree, target);
      const newActive = sib && remaining.includes(sib) ? sib : remaining[0];
      removedLeaf = target;
      return curr.map((x) =>
        x.id === tabId
          ? { ...x, paneTree: newTree, activeLeafId: newActive }
          : x,
      );
    });
    if (removedLeaf !== null) disposeSession(removedLeaf);
    return closedTab;
  }, []);

  const resetWorkspace = useCallback((cwd?: string) => {
    const tabId = nextIdRef.current++;
    const leafId = nextIdRef.current++;
    let toDispose: number[] = [];
    setTabs((curr) => {
      toDispose = curr.flatMap((t) =>
        t.kind === "terminal" ? leafIds(t.paneTree) : [],
      );
      return [
        {
          id: tabId,
          kind: "terminal",
          title: "shell",
          cwd,
          paneTree: { kind: "leaf", id: leafId, cwd },
          activeLeafId: leafId,
        },
      ];
    });
    setActiveId(tabId);
    for (const lid of toDispose) disposeSession(lid);
  }, []);

  const reorderTabByGap = useCallback((fromId: number, toGapIndex: number) => {
    setTabs((prev) => reorderTabsByGap(prev, fromId, toGapIndex));
  }, []);

  return {
    tabs,
    activeId,
    setActiveId,
    allocId,
    booted,
    replaceTabs,
    clearResumeIntent,
    reorderTabByGap,
    markBooted,
    setOverrideLanguage,
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
    openGitDiffTab,
    openCommitHistoryTab,
    openProjectsTab,
    renameProjectsTab,
    openNotesTab,
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
  };
}
