import { describe, expect, it } from "vitest";
import { IS_WINDOWS } from "@/lib/platform";
import type { Tab, TerminalTab } from "./useTabs";
import {
  hydrateTabs,
  serializeTabs,
  type SerializedTab,
} from "./serialize";

// The app's cold boot already took ids 1 and 2; a restore allocates from there on.
let nextId = 3;
const allocId = () => nextId++;

function terminalTab(over: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 1,
    kind: "terminal",
    title: "PasteLabel",
    paneTree: { kind: "leaf", id: 2, cwd: "F:/work/PasteLabel" },
    activeLeafId: 2,
    ...over,
  };
}

describe("hydrateTabs", () => {
  it("round-trips a terminal tab: tree, cwd, label, marks", () => {
    const tab = terminalTab({
      blocks: true,
      customTitle: "build",
      agent: "pi",
      sessionId: "ses_9",
    });
    const restored = hydrateTabs(serializeTabs([tab]), allocId, "Preview");
    expect(restored).toHaveLength(1);
    const t = restored[0];
    expect(t.kind).toBe("terminal");
    if (t.kind !== "terminal") return;
    expect(t.title).toBe("build");
    expect(t.cwd).toBe("F:/work/PasteLabel");
    expect(t.blocks).toBe(true);
    expect(t.agent).toBe("pi");
    expect(t.sessionId).toBe("ses_9");
    // Fresh ids: the restore must not collide with the cold tab's 1 and 2.
    expect(t.id).toBeGreaterThan(2);
    expect(t.activeLeafId).toBeGreaterThan(2);
  });

  it("marks a session tab for resume on its first activation", () => {
    const tab = terminalTab({ agent: "opencode", sessionId: "ses_1" });
    const restored = hydrateTabs(serializeTabs([tab]), allocId, "Preview");
    if (restored[0]?.kind !== "terminal") throw new Error("not terminal");
    expect(restored[0].pendingResume).toBe(true);
  });

  it("does not mark a plain terminal, and never writes the marker back out", () => {
    const withSession = terminalTab({ agent: "pi", sessionId: "ses_1" });
    const first = hydrateTabs(serializeTabs([withSession]), allocId, "P");
    const round = serializeTabs(first);
    expect(JSON.stringify(round)).not.toContain("pendingResume");
    const plain = hydrateTabs(serializeTabs([terminalTab()]), allocId, "P");
    if (plain[0]?.kind !== "terminal") throw new Error("not terminal");
    expect(plain[0].pendingResume).toBeUndefined();
  });

  it("a session tab without a tool comes back unmarked", () => {
    const tab = terminalTab({ sessionId: "ses_1" });
    const restored = hydrateTabs(serializeTabs([tab]), allocId, "Preview");
    if (restored[0]?.kind !== "terminal") throw new Error("not terminal");
    expect(restored[0].pendingResume).toBeUndefined();
    expect(restored[0].sessionId).toBe("ses_1");
  });

  it("drops a cwd that cannot name a directory in its env, and keeps it as the label", () => {
    // A drive-less POSIX path only reads as broken on Windows; elsewhere it is a normal path.
    if (!IS_WINDOWS) return;
    const tab = terminalTab({
      paneTree: { kind: "leaf", id: 2, cwd: "/work/PasteLabel" },
    });
    const restored = hydrateTabs(serializeTabs([tab]), allocId, "Preview");
    if (restored[0]?.kind !== "terminal") throw new Error("not terminal");
    expect(restored[0].cwd).toBeUndefined();
    // The label still says which directory it was.
    expect(restored[0].title).toBe("PasteLabel");
  });

  it("restores a split tree with the active leaf where it was", () => {
    const tab = terminalTab({
      paneTree: {
        kind: "split",
        id: 5,
        dir: "row",
        children: [
          { kind: "leaf", id: 6, cwd: "F:/work/a" },
          { kind: "leaf", id: 7, cwd: "F:/work/b" },
        ],
      },
      activeLeafId: 7,
    });
    const restored = hydrateTabs(serializeTabs([tab]), allocId, "Preview");
    if (restored[0]?.kind !== "terminal") throw new Error("not terminal");
    const tree = restored[0].paneTree;
    expect(tree.kind).toBe("split");
    if (tree.kind !== "split") return;
    expect(tree.children).toHaveLength(2);
    expect(restored[0].activeLeafId).toBe(tree.children[1].id);
  });

  it("restores editor, preview and markdown tabs", () => {
    const saved: SerializedTab[] = [
      { kind: "editor", path: "F:/work/a.ts" },
      { kind: "preview", url: "http://127.0.0.1:4173" },
      { kind: "markdown", path: "F:/work/readme.md" },
    ];
    const restored = hydrateTabs(saved, allocId, "Preview");
    expect(restored.map((t) => t.kind)).toEqual([
      "editor",
      "preview",
      "markdown",
    ]);
    const preview = restored[1];
    if (preview.kind !== "preview") throw new Error("not preview");
    // `URL.host` carries the port, which is what names a local dev server.
    expect(preview.title).toBe("127.0.0.1:4173");
  });

  it("round-trips a notes tab: folder, picked note, label", () => {
    const tab: Tab = {
      id: 9,
      kind: "notes",
      title: "笔记",
      root: "C:/app/notes",
      activePath: "C:/app/notes/note-2026-11-04-1030.md",
    };
    const restored = hydrateTabs(serializeTabs([tab]), allocId, "Preview");
    expect(restored).toHaveLength(1);
    const t = restored[0];
    expect(t.kind).toBe("notes");
    if (t.kind !== "notes") throw new Error("not notes");
    expect(t.title).toBe("笔记");
    expect(t.root).toBe("C:/app/notes");
    expect(t.activePath).toBe("C:/app/notes/note-2026-11-04-1030.md");
    expect(t.cold).toBe(true);
  });

  it("restores a notes tab with nothing picked when the file carried no pick", () => {
    const saved: SerializedTab[] = [{ kind: "notes", root: "C:/app/notes" }];
    const restored = hydrateTabs(saved, allocId, "Preview");
    const t = restored[0];
    if (t.kind !== "notes") throw new Error("not notes");
    expect(t.activePath).toBeNull();
  });

  it("skips a corrupted entry instead of failing the whole restore", () => {
    const saved = [
      null,
      { kind: "editor", path: "F:/work/a.ts" },
      { kind: "nonsense" },
    ] as unknown as SerializedTab[];
    const restored = hydrateTabs(saved, allocId, "Preview");
    expect(restored).toHaveLength(1);
  });
});
