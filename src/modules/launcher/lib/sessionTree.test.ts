import { describe, expect, it } from "vitest";
import { foldSessions } from "./sessionTree";
import type { AgentSession } from "./types";

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

const ids = (rows: ReturnType<typeof foldSessions>) =>
  rows
    .flatMap((row) => [row.parent.id, ...row.children.map((c) => c.id)])
    .sort();

describe("foldSessions", () => {
  it("keeps input order and attaches children to their parent", () => {
    const rows = foldSessions([
      session("a", null, 30),
      session("child1", "a", 20),
      session("b", null, 10),
      session("child2", "a", 5),
    ]);
    expect(rows.map((row) => row.parent.id)).toEqual(["a", "b"]);
    expect(rows[0].children.map((child) => child.id)).toEqual([
      "child1",
      "child2",
    ]);
    expect(rows[1].children).toEqual([]);
  });

  it("sorts children by recency", () => {
    const rows = foldSessions([
      session("a", null, 30),
      session("old", "a", 1),
      session("new", "a", 99),
    ]);
    expect(rows[0].children.map((child) => child.id)).toEqual(["new", "old"]);
  });

  it("promotes a child whose parent is not in the list", () => {
    const rows = foldSessions([session("orphan", "missing", 10)]);
    expect(rows.map((row) => row.parent.id)).toEqual(["orphan"]);
  });

  it("never drops a session from a chain", () => {
    expect(
      ids(
        foldSessions([
          session("a", null, 3),
          session("b", "a", 2),
          session("c", "b", 1),
        ]),
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("tolerates a parent cycle without losing either session", () => {
    expect(
      ids(foldSessions([session("a", "b", 2), session("b", "a", 1)])),
    ).toEqual(["a", "b"]);
  });

  it("tolerates a self parent", () => {
    const rows = foldSessions([session("self", "self", 1)]);
    expect(rows.map((row) => row.parent.id)).toEqual(["self"]);
  });

  it("handles an empty list", () => {
    expect(foldSessions([])).toEqual([]);
  });
});
