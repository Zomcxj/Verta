import { describe, expect, it } from "vitest";

import { subagentsOf } from "./sessionInfo";
import type { AgentSession, AgentTool } from "./types";

const session = (
  id: string,
  parentId: string | null,
  tool: AgentTool = "claude",
): AgentSession => ({
  tool,
  id,
  title: id,
  cwd: "C:/x",
  updatedAtMs: 0,
  parentId,
  distro: null,
});

/**
 * "What did this session start", asked of the rows themselves.
 *
 * The manage view draws subagents; the info dialog has to say how many there are without keeping a
 * second count that could disagree with them. Measured from the same list, that cannot happen.
 */
describe("the subagents of one session", () => {
  it("finds the rows filed under it", () => {
    const parent = session("s1", null);
    const rows = [parent, session("a", "s1"), session("b", "s1"), session("other", "s2")];
    expect(subagentsOf(rows, parent).map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("does not take another session's children", () => {
    const parent = session("s1", null);
    expect(subagentsOf([parent, session("x", "s2")], parent)).toEqual([]);
  });

  it("does not take another tool's child that happens to share the id", () => {
    // Ids are unique inside a tool; two tools using the same string is a collision, not a relation.
    const parent = session("s1", null, "claude");
    const rows = [parent, session("a", "s1", "pi")];
    expect(subagentsOf(rows, parent)).toEqual([]);
  });

  it("answers nothing when nothing is being read", () => {
    expect(subagentsOf([session("a", "s1")], null)).toEqual([]);
  });

  it("keeps the list's order, which is newest first", () => {
    const parent = session("s1", null);
    const rows = [parent, session("newer", "s1"), session("older", "s1")];
    expect(subagentsOf(rows, parent).map((row) => row.id)).toEqual([
      "newer",
      "older",
    ]);
  });
});
