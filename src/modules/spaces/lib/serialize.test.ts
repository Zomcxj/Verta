import { describe, expect, it } from "vitest";
import type { PaneNode } from "@/modules/terminal/lib/panes";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { hydrateTabs, serializeTabs, type SerializedTab } from "./serialize";

function counter(start = 100): () => number {
  let n = start;
  return () => n++;
}

function leafIdsOf(node: PaneNode): number[] {
  return node.kind === "leaf" ? [node.id] : node.children.flatMap(leafIdsOf);
}

function term(over: Partial<Extract<Tab, { kind: "terminal" }>>): Tab {
  return {
    id: 1,
    kind: "terminal",
    spaceId: "s1",
    title: "shell",
    paneTree: { kind: "leaf", id: 2, cwd: "/a" },
    activeLeafId: 2,
    ...over,
  } as Tab;
}

describe("serializeTabs", () => {
  it("drops private terminals and transient kinds", () => {
    const tabs: Tab[] = [
      term({ id: 1 }),
      term({ id: 3, private: true }),
      {
        id: 5,
        kind: "git-diff",
        spaceId: "s1",
        title: "d",
        path: "/a/x",
        repoRoot: "/a",
        mode: "+",
        originalPath: null,
        preview: true,
      },
      {
        id: 7,
        kind: "editor",
        spaceId: "s1",
        title: "x",
        path: "/a/x.ts",
        dirty: false,
        preview: false,
      },
    ];
    const out = serializeTabs(tabs);
    expect(out.map((t) => t.kind)).toEqual(["terminal", "editor"]);
  });

  it("marks the active leaf in a split tree", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "row",
      children: [
        { kind: "leaf", id: 11, cwd: "/a" },
        { kind: "leaf", id: 12, cwd: "/b" },
      ],
    };
    const [s] = serializeTabs([term({ paneTree: tree, activeLeafId: 12 })]);
    const node = s as Extract<SerializedTab, { kind: "terminal" }>;
    expect(node.tree.kind).toBe("split");
    if (node.tree.kind === "split") {
      expect(node.tree.children[1]).toMatchObject({ cwd: "/b", active: true });
      expect(node.tree.children[0]).not.toHaveProperty("active");
    }
  });

  it("keeps the environment and shell of a leaf, so a restore is faithful", () => {
    const tree: PaneNode = {
      kind: "leaf",
      id: 11,
      cwd: "/home/aj",
      workspace: { kind: "wsl", distro: "Ubuntu-22.04" },
      shell: "/bin/fish",
    };
    const [s] = serializeTabs([term({ paneTree: tree, activeLeafId: 11 })]);
    const node = s as Extract<SerializedTab, { kind: "terminal" }>;
    if (node.tree.kind !== "leaf") throw new Error("expected a leaf");
    expect(node.tree.workspace).toEqual({
      kind: "wsl",
      distro: "Ubuntu-22.04",
    });
    expect(node.tree.shell).toBe("/bin/fish");
  });
});

describe("hydrateTabs", () => {
  it("gives an old leaf without a workspace one derived from its cwd", () => {
    // 老数据只有 cwd：空间记着本机、标签停在发行版，恢复时要按 cwd 补上发行版。
    // 真实使用里「上次用过的发行版」是持久化的，这里照做。
    usePreferencesStore.setState({ lastWslDistro: "Ubuntu-22.04" });
    const serialized: SerializedTab[] = [
      {
        kind: "terminal",
        tree: { kind: "leaf", cwd: "/home/aj", active: true },
      },
    ];
    const [tab] = hydrateTabs(serialized, "s1", counter(), {
      kind: "local",
    });
    usePreferencesStore.setState({ lastWslDistro: null });
    if (tab?.kind !== "terminal") throw new Error("expected a terminal");
    expect(tab.paneTree).toMatchObject({
      cwd: "/home/aj",
      workspace: { kind: "wsl", distro: "Ubuntu-22.04" },
    });
  });

  it("keeps the workspace a leaf already had", () => {
    const serialized: SerializedTab[] = [
      {
        kind: "terminal",
        tree: {
          kind: "leaf",
          cwd: "C:/work",
          workspace: { kind: "wsl", distro: "Debian" },
          shell: "/bin/fish",
          active: true,
        },
      },
    ];
    const [tab] = hydrateTabs(serialized, "s1", counter(), {
      kind: "local",
    });
    if (tab?.kind !== "terminal") throw new Error("expected a terminal");
    expect(tab.paneTree).toMatchObject({
      workspace: { kind: "wsl", distro: "Debian" },
      shell: "/bin/fish",
    });
  });
  it("round-trips structure, cwd, blocks and active leaf", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "col",
      children: [
        { kind: "leaf", id: 11, cwd: "/a" },
        { kind: "leaf", id: 12, cwd: "/b" },
      ],
    };
    const tabs: Tab[] = [
      term({
        paneTree: tree,
        activeLeafId: 12,
        blocks: true,
        customTitle: "x",
      }),
    ];
    const serialized = serializeTabs(tabs);
    const [restored] = hydrateTabs(serialized, "s2", counter());
    expect(restored.kind).toBe("terminal");
    if (restored.kind !== "terminal") return;

    expect(restored.spaceId).toBe("s2");
    expect(restored.cold).toBe(true);
    expect(restored.blocks).toBe(true);
    expect(restored.customTitle).toBe("x");
    expect(restored.paneTree.kind).toBe("split");

    const leaves = leafIdsOf(restored.paneTree);
    expect(new Set(leaves).size).toBe(2);
    expect(leaves).toContain(restored.activeLeafId);
    // active leaf was the second one, which carried /b
    expect(restored.cwd).toBe("/b");
  });

  it("allocates fresh, unique, monotonic ids across all tabs and leaves", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "row",
      children: [
        { kind: "leaf", id: 11, cwd: "/a" },
        { kind: "leaf", id: 12, cwd: "/b" },
      ],
    };
    const serialized = serializeTabs([
      term({ id: 1, paneTree: tree, activeLeafId: 11 }),
      term({ id: 2 }),
    ]);
    const restored = hydrateTabs(serialized, "s1", counter(100));

    const ids: number[] = [];
    for (const t of restored) {
      ids.push(t.id);
      if (t.kind === "terminal") ids.push(...leafIdsOf(t.paneTree));
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.min(...ids)).toBeGreaterThanOrEqual(100);
  });

  it("returns empty for corrupted input without throwing", () => {
    expect(hydrateTabs([] as SerializedTab[], "s1", counter())).toEqual([]);
    expect(
      hydrateTabs(null as unknown as SerializedTab[], "s1", counter()),
    ).toEqual([]);
  });

  it("hydrates editor/preview/markdown as cold with derived titles", () => {
    const serialized: SerializedTab[] = [
      { kind: "editor", path: "/a/foo.ts" },
      { kind: "preview", url: "http://localhost:5173/x" },
      { kind: "markdown", path: "/a/README.md" },
    ];
    const out = hydrateTabs(serialized, "s1", counter());
    expect(out.every((t) => t.cold === true)).toBe(true);
    expect(out.map((t) => t.title)).toEqual([
      "foo.ts",
      "localhost:5173",
      "README.md",
    ]);
  });
});
