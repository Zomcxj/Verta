import {
  isLeaf,
  type PaneNode,
  type SplitDir,
} from "@/modules/terminal/lib/panes";
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
      /** 存下来，恢复时才知道这个叶子该开在本机还是哪个发行版里。 */
      workspace?: WorkspaceEnv;
      /** 存下来，恢复时用的还是当初那个 shell，而不是设置里的默认终端。 */
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
};

/**
 * 老数据里叶子只存了 cwd。按 cwd 把环境补回去，恢复出来的每个终端才会在自己的环境里启动；
 * 少了这一步，存着发行版路径的那些终端会带着 Linux 路径去本机启动。
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
  fallbackEnv?: WorkspaceEnv,
): PaneNode {
  if (node.kind === "leaf") {
    const id = allocId();
    if (node.active && acc.activeLeafId === null) acc.activeLeafId = id;
    return {
      kind: "leaf",
      id,
      ...(node.cwd !== undefined && { cwd: node.cwd }),
      ...(node.workspace !== undefined
        ? { workspace: node.workspace }
        : restoredLeafEnv(node.cwd, fallbackEnv)),
      ...(node.shell !== undefined && { shell: node.shell }),
    };
  }
  const children = node.children.map((c) =>
    hydrateNode(c, allocId, acc, fallbackEnv),
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
  const paneTree = hydrateNode(tree, allocId, acc, fallbackEnv);
  const leaves = collectLeaves(paneTree);
  const activeLeafId = acc.activeLeafId ?? leaves[0]?.id ?? allocId();
  const firstLeafCwd =
    leaves.find((l) => l.id === activeLeafId)?.cwd ?? leaves[0]?.cwd;
  return { tree: paneTree, activeLeafId, firstLeafCwd };
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
      const { tree, activeLeafId, firstLeafCwd } = hydrateTree(
        s.tree,
        allocId,
        fallbackEnv,
      );
      const title =
        s.customTitle ??
        (firstLeafCwd ? basename(firstLeafCwd) : s.blocks ? "blocks" : "shell");
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
