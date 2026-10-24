import {
  isLeaf,
  type PaneNode,
  type SplitDir,
} from "@/modules/terminal/lib/panes";
import { IS_WINDOWS } from "@/lib/platform";
import type {
  EditorTab,
  MarkdownTab,
  PreviewTab,
  Tab,
  TerminalTab,
} from "@/modules/tabs/lib/useTabs";
import type { AgentTool } from "@/modules/launcher/lib/types";
import type { WorkspaceEnv } from "@/modules/workspace";
import { envForPath } from "@/modules/workspace";

type SerializedNode =
  | {
      kind: "leaf";
      cwd?: string;
      /** Stored so the restore knows whether this leaf opens locally or in a distro. */
      workspace?: WorkspaceEnv;
      /** Stored so the restore keeps the original shell instead of the default terminal
       * from preferences. */
      shell?: string;
      active?: boolean;
    }
  | { kind: "split"; dir: SplitDir; children: SerializedNode[] };

export type SerializedTab =
  | {
      kind: "terminal";
      tree: SerializedNode;
      blocks?: boolean;
      customTitle?: string;
      agent?: AgentTool;
    }
  | { kind: "editor"; path: string }
  | { kind: "preview"; url: string }
  | { kind: "markdown"; path: string };

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function titleFromUrl(url: string, fallback: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url || fallback;
  }
}

function serializeNode(node: PaneNode, activeLeafId: number): SerializedNode {
  if (isLeaf(node)) {
    return {
      kind: "leaf",
      ...(node.cwd !== undefined && { cwd: node.cwd }),
      ...(node.workspace !== undefined && { workspace: node.workspace }),
      ...(node.shell !== undefined && { shell: node.shell }),
      ...(node.id === activeLeafId && { active: true }),
    };
  }
  return {
    kind: "split",
    dir: node.dir,
    children: node.children.map((c) => serializeNode(c, activeLeafId)),
  };
}

export function isSerializableTab(tab: Tab): boolean {
  switch (tab.kind) {
    case "terminal":
      return !tab.private;
    case "editor":
    case "preview":
    case "markdown":
      return true;
    default:
      return false;
  }
}

function serializeTab(tab: Tab): SerializedTab | null {
  if (!isSerializableTab(tab)) return null;
  switch (tab.kind) {
    case "terminal":
      return {
        kind: "terminal",
        tree: serializeNode(tab.paneTree, tab.activeLeafId),
        ...(tab.blocks && { blocks: true }),
        ...(tab.customTitle !== undefined && { customTitle: tab.customTitle }),
        ...(tab.agent !== undefined && { agent: tab.agent }),
      };
    case "editor":
      return { kind: "editor", path: tab.path };
    case "preview":
      return { kind: "preview", url: tab.url };
    case "markdown":
      return { kind: "markdown", path: tab.path };
    default:
      return null;
  }
}

export function serializeTabs(tabs: Tab[]): SerializedTab[] {
  const out: SerializedTab[] = [];
  for (const tab of tabs) {
    const s = serializeTab(tab);
    if (s) out.push(s);
  }
  return out;
}

type HydratedTree = {
  tree: PaneNode;
  activeLeafId: number;
  firstLeafCwd?: string;
  /** The cwd as it was stored, before an unusable one is dropped; the tab is labelled
   * from this so a restored terminal still says which directory it was. */
  firstLeafStoredCwd?: string;
};

/**
 * Whether this cwd can name a real directory in this env, judged by its shape alone.
 *
 * A **local** terminal on Windows needs a drive (`F:\work`) or a UNC share: a value like
 * `/VibeCoding_workspace/Verta` is what a Windows path looks like after it lost its drive
 * letter, and Windows resolves it against whichever drive the app's own process sits on.
 * That is how a restored tab opened somewhere nobody asked for, and on a machine whose
 * current drive lacks the path it failed outright. Distro paths are Linux paths, so they
 * are checked for their leading slash.
 */
function cwdFitsEnv(cwd: string, workspace: WorkspaceEnv): boolean {
  if (workspace.kind === "wsl") return cwd.startsWith("/");
  if (!IS_WINDOWS) return cwd.startsWith("/");
  return /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\");
}

/** The env a restored leaf belongs to: the stored one, or the one its cwd implies. */
function leafWorkspace(
  node: { cwd?: string; workspace?: WorkspaceEnv },
  fallbackEnv?: WorkspaceEnv,
): WorkspaceEnv | undefined {
  return node.workspace ?? restoredLeafEnv(node.cwd, fallbackEnv).workspace;
}

/**
 * In old data a leaf stored only its cwd. Recovering the env from that cwd lets each
 * restored terminal start in its own env; without this step, terminals holding distro
 * paths would start locally with a Linux path.
 */
function restoredLeafEnv(
  cwd: string | undefined,
  fallback: WorkspaceEnv | undefined,
): { workspace?: WorkspaceEnv } {
  if (!cwd || !fallback) return {};
  return { workspace: envForPath(cwd, fallback) };
}

function hydrateNode(
  node: SerializedNode,
  allocId: () => number,
  acc: { activeLeafId: number | null },
  storedCwds: Map<number, string>,
  fallbackEnv?: WorkspaceEnv,
): PaneNode {
  if (node.kind === "leaf") {
    const id = allocId();
    if (node.active && acc.activeLeafId === null) acc.activeLeafId = id;
    // Keep the cwd as stored, even when it is dropped below: the tab is labelled from it.
    if (node.cwd !== undefined) storedCwds.set(id, node.cwd);
    const workspace = leafWorkspace(node, fallbackEnv);
    const cwd =
      node.cwd !== undefined &&
      workspace !== undefined &&
      !cwdFitsEnv(node.cwd, workspace)
        ? undefined
        : node.cwd;
    return {
      kind: "leaf",
      id,
      ...(cwd !== undefined && { cwd }),
      ...(workspace !== undefined && { workspace }),
      ...(node.shell !== undefined && { shell: node.shell }),
    };
  }
  const children = node.children.map((c) =>
    hydrateNode(c, allocId, acc, storedCwds, fallbackEnv),
  );
  if (children.length === 0) return { kind: "leaf", id: allocId() };
  if (children.length === 1) return children[0];
  return { kind: "split", id: allocId(), dir: node.dir, children };
}

function hydrateTree(
  tree: SerializedNode,
  allocId: () => number,
  fallbackEnv?: WorkspaceEnv,
): HydratedTree {
  const acc: { activeLeafId: number | null } = { activeLeafId: null };
  const storedCwds = new Map<number, string>();
  const paneTree = hydrateNode(tree, allocId, acc, storedCwds, fallbackEnv);
  const leaves = collectLeaves(paneTree);
  const activeLeafId = acc.activeLeafId ?? leaves[0]?.id ?? allocId();
  const activeLeaf = leaves.find((l) => l.id === activeLeafId) ?? leaves[0];
  return {
    tree: paneTree,
    activeLeafId,
    firstLeafCwd: activeLeaf?.cwd,
    firstLeafStoredCwd: activeLeaf?.cwd ?? storedCwds.get(activeLeaf?.id ?? -1),
  };
}

function collectLeaves(node: PaneNode): Array<{ id: number; cwd?: string }> {
  if (isLeaf(node)) return [{ id: node.id, cwd: node.cwd }];
  return node.children.flatMap(collectLeaves);
}

function hydrateTab(
  s: SerializedTab,
  allocId: () => number,
  previewFallback: string,
  fallbackEnv?: WorkspaceEnv,
): Tab | null {
  switch (s.kind) {
    case "terminal": {
      const { tree, activeLeafId, firstLeafCwd, firstLeafStoredCwd } =
        hydrateTree(s.tree, allocId, fallbackEnv);
      // The label comes from the cwd as stored, so a terminal whose directory had to be
      // dropped still says which one it was until the shell reports where it really is.
      const labelCwd = firstLeafStoredCwd ?? firstLeafCwd;
      const title =
        s.customTitle ??
        (labelCwd ? basename(labelCwd) : s.blocks ? "blocks" : "shell");
      return {
        id: allocId(),
        kind: "terminal",
        cold: true,
        title,
        cwd: firstLeafCwd,
        paneTree: tree,
        activeLeafId,
        ...(s.blocks && { blocks: true }),
        ...(s.customTitle !== undefined && { customTitle: s.customTitle }),
        ...(s.agent !== undefined && { agent: s.agent }),
      } satisfies TerminalTab;
    }
    case "editor":
      return {
        id: allocId(),
        kind: "editor",
        cold: true,
        title: basename(s.path),
        path: s.path,
        dirty: false,
        preview: false,
      } satisfies EditorTab;
    case "preview":
      return {
        id: allocId(),
        kind: "preview",
        cold: true,
        title: titleFromUrl(s.url, previewFallback),
        url: s.url,
      } satisfies PreviewTab;
    case "markdown":
      return {
        id: allocId(),
        kind: "markdown",
        cold: true,
        title: basename(s.path),
        path: s.path,
      } satisfies MarkdownTab;
    default:
      return null;
  }
}

export function freshTerminalTab(
  cwd: string | null,
  allocId: () => number,
): TerminalTab {
  const leafId = allocId();
  return {
    id: allocId(),
    kind: "terminal",
    cold: true,
    title: cwd ? basename(cwd) : "shell",
    cwd: cwd ?? undefined,
    paneTree: { kind: "leaf", id: leafId, ...(cwd && { cwd }) },
    activeLeafId: leafId,
  };
}

export function hydrateTabs(
  serialized: SerializedTab[],
  allocId: () => number,
  previewFallback: string,
  fallbackEnv?: WorkspaceEnv,
): Tab[] {
  if (!Array.isArray(serialized)) return [];
  const out: Tab[] = [];
  for (const s of serialized) {
    try {
      const tab = hydrateTab(s, allocId, previewFallback, fallbackEnv);
      if (tab) out.push(tab);
    } catch {
      // Skip corrupted entries rather than failing the whole restore.
    }
  }
  return out;
}
