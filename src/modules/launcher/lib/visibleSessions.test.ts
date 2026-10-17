import { describe, expect, it } from "vitest";
import type { AgentSession } from "./types";
import { hiddenSubagentCount, topLevelSessions } from "./visibleSessions";

const session = (
  id: string,
  parentId: string | null,
  updatedAtMs: number,
): AgentSession => ({
  tool: "opencode",
  id,
  title: id,
  cwd: "F:/x",
  updatedAtMs,
  parentId,
});

describe("topLevelSessions", () => {
  it("keeps the input order and drops children of listed sessions", () => {
    const rows = topLevelSessions([
      session("a", null, 30),
      session("child1", "a", 20),
      session("b", null, 10),
      session("child2", "a", 5),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("keeps a child whose parent is outside the query window", () => {
    const rows = topLevelSessions([session("orphan", "gone", 10)]);
    expect(rows.map((row) => row.id)).toEqual(["orphan"]);
  });

  it("keeps a self-parented session", () => {
    const rows = topLevelSessions([session("self", "self", 1)]);
    expect(rows.map((row) => row.id)).toEqual(["self"]);
  });

  it("handles an empty list", () => {
    expect(topLevelSessions([])).toEqual([]);
  });

  it("counts the hidden subagent sessions", () => {
    const all = [
      session("a", null, 3),
      session("child", "a", 2),
      session("b", null, 1),
    ];
    expect(hiddenSubagentCount(all)).toBe(1);
    expect(hiddenSubagentCount([])).toBe(0);
  });
});
