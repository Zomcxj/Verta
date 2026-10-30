import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { AgentStateDot } from "@/modules/terminal/AgentStateDot";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import {
  activeByWindow,
  backgroundStateById,
  sessionStateById,
  waitingFirst,
} from "./sessionActivity";

/** A terminal tab with one leaf, opened for a session. */
function terminalTab(
  sessionId: string | undefined,
  leafId: number,
  extra?: { split?: number },
): Tab {
  const tree =
    extra?.split === undefined
      ? { kind: "leaf" as const, id: leafId }
      : {
          kind: "split" as const,
          id: 900,
          dir: "row" as const,
          children: [
            { kind: "leaf" as const, id: leafId },
            { kind: "leaf" as const, id: extra.split },
          ],
        };
  return {
    id: 1,
    kind: "terminal",
    title: "session",
    paneTree: tree,
    activeLeafId: leafId,
    ...(sessionId !== undefined && { sessionId }),
  } as Tab;
}

describe("sessionStateById", () => {
  it("finds a session's state through the tab that resumed it", () => {
    const states = sessionStateById({
      tabs: [terminalTab("ses_a", 5)],
      leafPty: { 5: 42 },
      phases: { 42: "working" },
      agents: {},
      unseenDone: {},
    });
    expect(states.get("ses_a")).toBe("working");
  });

  it("leaves a session with no tab out of the map", () => {
    // Nothing is running for it: the honest answer is "no state", not "idle".
    const states = sessionStateById({
      tabs: [],
      leafPty: {},
      phases: { 42: "attention" },
      agents: {},
      unseenDone: {},
    });
    expect(states.size).toBe(0);
  });

  it("ignores a tab that is not a resumed session", () => {
    const states = sessionStateById({
      tabs: [terminalTab(undefined, 5)],
      leafPty: { 5: 42 },
      phases: { 42: "attention" },
      agents: {},
      unseenDone: {},
    });
    expect(states.size).toBe(0);
  });

  it("ignores a tab whose leaves have no pty yet", () => {
    // A restored tab that has not been started has no pty, so no state to show.
    const states = sessionStateById({
      tabs: [terminalTab("ses_a", 5)],
      leafPty: {},
      phases: { 42: "attention" },
      agents: {},
      unseenDone: {},
    });
    expect(states.size).toBe(0);
  });

  it("takes the loudest state of a session split across panes", () => {
    const states = sessionStateById({
      tabs: [terminalTab("ses_a", 5, { split: 6 })],
      leafPty: { 5: 42, 6: 43 },
      phases: { 42: "working", 43: "attention" },
      agents: {},
      unseenDone: {},
    });
    expect(states.get("ses_a")).toBe("attention");
  });

  it("folds two tabs opened for the same session into one state", () => {
    // One end of the session is at rest and the other has just ended: with the ending still
    // unseen the session reads as ended, and once it has been looked at both are just "at rest".
    const base = {
      tabs: [terminalTab("ses_a", 5), { ...terminalTab("ses_a", 6), id: 2 }],
      leafPty: { 5: 42, 6: 43 },
      phases: { 42: "idle", 43: "finished" },
      agents: { 42: "opencode", 43: "opencode" },
    } as const;
    expect(
      sessionStateById({ ...base, unseenDone: { 43: 1_000 } }).get("ses_a"),
    ).toBe("finished");
    expect(sessionStateById({ ...base, unseenDone: {} }).get("ses_a")).toBe(
      "idle",
    );
  });

  it("keeps two sessions apart", () => {
    const states = sessionStateById({
      tabs: [
        { ...terminalTab("ses_a", 5), id: 1 },
        { ...terminalTab("ses_b", 6), id: 2 },
      ],
      leafPty: { 5: 42, 6: 43 },
      phases: { 42: "working", 43: "attention" },
      agents: {},
      unseenDone: {},
    });
    expect(states.get("ses_a")).toBe("working");
    expect(states.get("ses_b")).toBe("attention");
  });

  it("says nothing for a session whose pty the store never heard of", () => {
    const states = sessionStateById({
      tabs: [terminalTab("ses_a", 5)],
      leafPty: { 5: 42 },
      phases: {},
      agents: {},
      unseenDone: {},
    });
    expect(states.size).toBe(0);
  });
});

describe("waitingFirst", () => {
  const rows = [
    { id: "a" },
    { id: "b" },
    { id: "c" },
  ];

  it("returns the list untouched when nothing is waiting", () => {
    const state = new Map([["b", "working" as const]]);
    expect(waitingFirst(rows, state)).toBe(rows);
  });

  it("lifts the waiting session to the top", () => {
    const state = new Map([["c", "attention" as const]]);
    expect(waitingFirst(rows, state).map((row) => row.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("keeps the order of everything else, and of several waiters", () => {
    const state = new Map([
      ["a", "attention" as const],
      ["c", "attention" as const],
      ["b", "finished" as const],
    ]);
    expect(waitingFirst(rows, state).map((row) => row.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("leaves rows with no state where they were", () => {
    const state = new Map<string, "attention">([["b", "attention"]]);
    expect(waitingFirst(rows, state).map((row) => row.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });
});
describe("the background read", () => {
  const panel = readFileSync(
    new URL("../components/LauncherPanel.tsx", import.meta.url),
    "utf8",
  );

  it("stops asking while the window is put away", () => {
    // "Only when somebody could see it" has to include the window sitting in the tray, where the
    // panel stays mounted and nothing can be looked at.
    expect(panel).toContain("useWindowHidden()");
    expect(panel).toMatch(/windowHidden/);
  });

  it("takes its times from the rows, with no query of its own", () => {
    // The whole point of this signal is that it is already in the list: a read of its own would be a
    // second source of truth for the same fact.
    expect(panel).toContain("activeByWindow(");
    expect(panel).toContain("ACTIVE_WINDOW_MS");
    expect(panel).not.toContain("agentBackgroundSessions");
  });
});

describe("backgroundStateById", () => {
  const row = (id: string, parentId: string | null = null) => ({ id, parentId });

  it("fills in a session that was written to but has no tab", () => {
    // The case the user asked for: an opencode left running without a terminal in this window.
    const merged = backgroundStateById(
      new Map(),
      new Set(["ses_live"]),
      [row("ses_live"), row("ses_quiet")],
    );
    expect(merged.get("ses_live")).toBe("background");
    expect(merged.has("ses_quiet")).toBe(false);
  });

  it("lets the tab's own reading win, whatever it says", () => {
    // A question waiting is blue; a recent write must never paint over it orange.
    const states = new Map<string, AgentStateDot>([["ses_live", "attention"]]);
    const merged = backgroundStateById(states, new Set(["ses_live"]), [row("ses_live")]);
    expect(merged.get("ses_live")).toBe("attention");
    // And the map it was given is not mutated.
    expect([...states.entries()]).toEqual([["ses_live", "attention"]]);
  });

  it("leaves subagent sessions to their parent", () => {
    // A subagent writes through its parent: marking it separately would light two rows for one
    // agent.
    const merged = backgroundStateById(new Map(), new Set(["ses_child"]), [
      row("ses_child", "ses_parent"),
    ]);
    expect(merged.has("ses_child")).toBe(false);
  });

  it("ignores ids that are not in the list at all", () => {
    const merged = backgroundStateById(new Map(), new Set(["ses_gone"]), [row("ses_other")]);
    expect(merged.size).toBe(0);
  });
});

describe("activeByWindow", () => {
  const MINUTE = 60_000;
  const row = (id: string, lastAtMs: number | null, parentId: string | null = null) => ({
    id,
    parentId,
    lastAtMs,
  });

  it("counts a session written to inside the window", () => {
    const now = 1_000_000;
    const active = activeByWindow([row("a", now - 3_000), row("b", now - 5 * MINUTE)], now, MINUTE);
    expect([...active]).toEqual(["a"]);
  });

  it("is a window, not a threshold on 'the newest session'", () => {
    // Two sessions writing at the same time are both active: this is not a ranking.
    const now = 1_000_000;
    const active = activeByWindow([row("a", now - 1_000), row("b", now - 2_000)], now, MINUTE);
    expect([...active].sort()).toEqual(["a", "b"]);
  });

  it("excludes the exact boundary and anything older", () => {
    const now = 1_000_000;
    expect(activeByWindow([row("a", now - MINUTE)], now, MINUTE).size).toBe(0);
    expect(activeByWindow([row("a", now - MINUTE + 1)], now, MINUTE).size).toBe(1);
  });

  it("treats a missing time as not active", () => {
    const now = 1_000_000;
    expect(activeByWindow([row("a", null)], now, MINUTE).size).toBe(0);
  });

  it("counts a time in the future as active rather than arithmetically impossible", () => {
    // The clock going backwards, or the tool writing a time slightly ahead of ours, must not
    // produce a negative age that quietly stops the mark from ever being drawn.
    const now = 1_000_000;
    expect(activeByWindow([row("a", now + 5_000)], now, MINUTE).size).toBe(1);
  });

  it("leaves subagent sessions alone", () => {
    const now = 1_000_000;
    expect(activeByWindow([row("child", now, "parent")], now, MINUTE).size).toBe(0);
  });

  it("falls back to the session's own update time when it has no conversation time", () => {
    // `statsOf` already treats the two as one number, and a session touched seconds ago is active
    // whichever of the two moved.
    const now = 1_000_000;
    const active = activeByWindow(
      [{ id: "a", parentId: null, updatedAtMs: now - 1_000 }],
      now,
      MINUTE,
    );
    expect([...active]).toEqual(["a"]);
  });
});
