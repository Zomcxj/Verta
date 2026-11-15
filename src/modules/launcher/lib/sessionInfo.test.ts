import { describe, expect, it } from "vitest";

import { parentCountKey, subagentsByParent, subagentsOf } from "./sessionInfo";
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

/**
 * The same relation, asked of every session at once.
 *
 * The manage view's badge and the hover card both need the children of a row without a hover to look
 * up first, and both have to agree with `subagentsOf` about what a child is - so the grouping is
 * keyed the same way, per tool and parent id, and keeps the list's order.
 */
describe("the subagents of every session", () => {
  it("groups the rows under their parent, per tool", () => {
    const rows = [
      session("s1", null),
      session("a", "s1"),
      session("b", "s1"),
      session("s1", null, "pi"),
      session("c", "s1", "pi"),
    ];
    const byParent = subagentsByParent(rows);
    // Two tools, two parents: an id is unique only within a tool, so the groups are too.
    expect(
      byParent.get(parentCountKey("claude", "s1"))?.map((row) => row.id),
    ).toEqual(["a", "b"]);
    expect(
      byParent.get(parentCountKey("pi", "s1"))?.map((row) => row.id),
    ).toEqual(["c"]);
    expect(byParent.get(parentCountKey("claude", "a"))).toBeUndefined();
  });

  it("agrees with the per-session lookup", () => {
    const parent = session("s1", null);
    const rows = [parent, session("a", "s1"), session("other", "s2")];
    expect(subagentsByParent(rows).get(parentCountKey("claude", "s1"))).toEqual(
      subagentsOf(rows, parent),
    );
  });

  it("groups nothing when nothing is filed anywhere", () => {
    expect(subagentsByParent([session("s1", null)]).size).toBe(0);
  });
});
