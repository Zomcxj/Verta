import { describe, expect, it } from "vitest";
import {
  deletionSummary,
  selectedTargets,
  sessionKey,
  toggleSelection,
  updateSelection,
} from "./selection";
import type { AgentSession } from "./types";

const session = (
  id: string,
  tool: AgentSession["tool"] = "opencode",
  parentId: string | null = null,
  distro: string | null = null,
): AgentSession => ({
  tool,
  id,
  title: id,
  cwd: "F:/x",
  updatedAtMs: 1,
  parentId,
  distro,
});

describe("sessionKey", () => {
  it("qualifies an id with its tool and its source", () => {
    expect(sessionKey(session("ses_1"))).toBe("opencode::ses_1");
    expect(sessionKey(session("01a147ad", "pi"))).toBe("pi::01a147ad");
  });

  it("keeps the same id in two stores apart", () => {
    expect(sessionKey(session("ses_1", "opencode", null, "Ubuntu-22.04"))).toBe(
      "opencode:Ubuntu-22.04:ses_1",
    );
    expect(sessionKey(session("ses_1"))).not.toBe(
      sessionKey(session("ses_1", "opencode", null, "Ubuntu-22.04")),
    );
  });
});

describe("toggleSelection", () => {
  it("adds then removes a key", () => {
    const first = toggleSelection(new Set<string>(), "pi:a");
    expect([...first]).toEqual(["pi:a"]);
    expect([...toggleSelection(first, "pi:a")]).toEqual([]);
  });

  it("never mutates the input", () => {
    const input = new Set(["pi:a"]);
    toggleSelection(input, "pi:b");
    expect([...input]).toEqual(["pi:a"]);
  });
});

describe("updateSelection", () => {
  it("selects every visible key", () => {
    expect(
      [...updateSelection(new Set(), "all", ["pi:a", "pi:b"])].sort(),
    ).toEqual(["pi:a", "pi:b"]);
  });

  it("adds to an existing selection instead of replacing it", () => {
    expect(
      [...updateSelection(new Set(["pi:z"]), "all", ["pi:a"])].sort(),
    ).toEqual(["pi:a", "pi:z"]);
  });

  it("clears only the visible keys", () => {
    expect([
      ...updateSelection(new Set(["pi:a", "pi:z"]), "none", ["pi:a"]),
    ]).toEqual(["pi:z"]);
  });
});

describe("selectedTargets", () => {
  it("returns tool, id and source in list order, never a path", () => {
    const sessions = [
      session("a"),
      session("b", "pi"),
      session("c", "opencode", null, "Ubuntu-22.04"),
    ];
    const selected = new Set([
      "opencode::c",
      "opencode::a",
      "pi::b",
      "opencode:Ubuntu-22.04:c",
    ]);
    expect(selectedTargets(sessions, selected)).toEqual([
      { tool: "opencode", id: "a", distro: null },
      { tool: "pi", id: "b", distro: null },
      { tool: "opencode", id: "c", distro: "Ubuntu-22.04" },
    ]);
  });

  it("ignores a selected key that is no longer listed", () => {
    expect(
      selectedTargets([session("a")], new Set(["opencode::gone"])),
    ).toEqual([]);
  });

  it("returns nothing for an empty selection", () => {
    expect(selectedTargets([session("a")], new Set())).toEqual([]);
  });
});

describe("deletionSummary", () => {
  it("counts by tool and how many are subagent sessions", () => {
    const summary = deletionSummary([
      session("a"),
      session("child", "opencode", "a"),
      session("b", "pi"),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.byTool).toEqual({ opencode: 2, pi: 1 });
    expect(summary.subagents).toBe(1);
    expect(summary.hasSubagents).toBe(true);
  });

  it("handles an empty selection", () => {
    const summary = deletionSummary([]);
    expect(summary.total).toBe(0);
    expect(summary.byTool).toEqual({ opencode: 0, pi: 0 });
    expect(summary.subagents).toBe(0);
    expect(summary.hasSubagents).toBe(false);
  });
});
