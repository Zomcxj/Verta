import { describe, expect, it } from "vitest";
import type { Tab } from "@/modules/tabs";
import { pendingAttentions, questionExcerpt, tabForPty } from "./attentions";

const terminalTab = (id: number, title: string, leaves: number[]): Tab =>
  ({
    id,
    kind: "terminal",
    title,
    customTitle: title,
    paneTree:
      leaves.length === 1
        ? { kind: "leaf", id: leaves[0], cwd: "C:/work" }
        : {
            kind: "split",
            direction: "row",
            children: leaves.map((leafId) => ({
              kind: "leaf" as const,
              id: leafId,
              cwd: "C:/work",
            })),
          },
    activeLeafId: leaves[0],
  }) as unknown as Tab;

const editorTab = { id: 99, kind: "editor", title: "notes.md" } as unknown as Tab;

describe("pendingAttentions", () => {
  it("is empty for a window with nothing waiting", () => {
    expect(
      pendingAttentions([terminalTab(1, "Study", [11])], {
        unseen: {},
        leafPty: { 11: 7 },
        agents: { 7: "opencode" },
      }),
    ).toEqual([]);
  });

  it("reports the tab, the session and the moment it started waiting", () => {
    const found = pendingAttentions([terminalTab(3, "Study", [11])], {
      unseen: { 7: 5_000 },
      leafPty: { 11: 7 },
      agents: { 7: "opencode" },
    });
    expect(found).toEqual([
      {
        ptyId: 7,
        leafId: 11,
        tabId: 3,
        title: "Study",
        agent: "opencode",
        sinceMs: 5_000,
      },
    ]);
  });

  it("puts the newest question first", () => {
    const found = pendingAttentions(
      [terminalTab(1, "A", [11]), terminalTab(2, "B", [12])],
      {
        unseen: { 7: 5_000, 8: 9_000 },
        leafPty: { 11: 7, 12: 8 },
        agents: { 7: "claude", 8: "codex" },
      },
    );
    expect(found.map((item) => item.ptyId)).toEqual([8, 7]);
  });

  it("lists a waiting pane of a split tab, not the tab twice", () => {
    const found = pendingAttentions([terminalTab(1, "A", [11, 12])], {
      unseen: { 8: 9_000 },
      leafPty: { 11: 7, 12: 8 },
      agents: {},
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ ptyId: 8, leafId: 12, agent: null });
  });

  it("ignores tabs that cannot hold a session", () => {
    expect(
      pendingAttentions([editorTab], {
        unseen: { 7: 5_000 },
        leafPty: { 11: 7 },
        agents: {},
      }),
    ).toEqual([]);
  });

  it("ignores a latch whose leaf has no pty yet", () => {
    expect(
      pendingAttentions([terminalTab(1, "A", [11])], {
        unseen: { 7: 5_000 },
        leafPty: {},
        agents: {},
      }),
    ).toEqual([]);
  });
});

describe("tabForPty", () => {
  it("finds where a session is drawn right now", () => {
    const tabs = [
      terminalTab(1, "A", [11, 12]),
      editorTab,
      terminalTab(2, "B", [13]),
    ];
    const leafPty = { 11: 7, 12: 8, 13: 9 };
    expect(tabForPty(tabs, leafPty, 8)).toEqual({ tabId: 1, leafId: 12 });
    expect(tabForPty(tabs, leafPty, 9)).toEqual({ tabId: 2, leafId: 13 });
  });

  it("has nothing to point at for a session no tab is showing", () => {
    const tabs = [terminalTab(1, "A", [11])];
    // Nobody draws this pty...
    expect(tabForPty(tabs, { 11: 7 }, 99)).toBe(null);
    // ...and a leaf whose pty is not known yet is not a match either.
    expect(tabForPty(tabs, {}, 7)).toBe(null);
  });
});

describe("questionExcerpt", () => {
  it("reads the bottom of the screen as one line", () => {
    const tail = [
      "the agent did some work",
      "",
      "△ Permission required",
      "  Allow once",
      "ctrl+p commands",
    ].join("\n");
    expect(questionExcerpt(tail)).toBe(
      "△ Permission required · Allow once · ctrl+p commands",
    );
  });

  it("collapses runs of spaces and a wide screen's blank rows", () => {
    expect(questionExcerpt("  Ask   anything…   \n\n   \n")).toBe("Ask anything…");
  });

  it("leaves nothing for a screen with nothing on it", () => {
    expect(questionExcerpt("")).toBe("");
    expect(questionExcerpt(null)).toBe("");
    expect(questionExcerpt("   \n\n  \n")).toBe("");
  });

  it("caps a long question instead of letting the row grow", () => {
    const excerpt = questionExcerpt("x".repeat(500), 40);
    expect(excerpt).toHaveLength(40);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});