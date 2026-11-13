import { describe, expect, it } from "vitest";
import type { AgentSession, AgentTool } from "./types";
import { topLevelSessions } from "./visibleSessions";

const session = (
  id: string,
  parentId: string | null,
  updatedAtMs: number,
  tool: AgentTool = "opencode",
): AgentSession => ({
  tool,
  id,
  title: id,
  cwd: "F:/x",
  updatedAtMs,
  parentId,
  distro: null,
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

  it("keeps an opencode child whose parent is outside the query window", () => {
    const rows = topLevelSessions([session("orphan", "gone", 10)]);
    expect(rows.map((row) => row.id)).toEqual(["orphan"]);
  });

  it("keeps a self-parented session", () => {
    const rows = topLevelSessions([session("self", "self", 1)]);
    expect(rows.map((row) => row.id)).toEqual(["self"]);
  });

  it("hides a pi fork even when the session it branched from is gone", () => {
    // Real data: 01a08653 is a `subagent-worker-*` fork whose parent transcript
    // was deleted, so its parent never appears in the list.
    const rows = topLevelSessions([
      session("keep", null, 20, "pi"),
      session("01a08653", "C:\\...\\2026-09-09T10-55-18-316Z_01a085ce.jsonl", 10, "pi"),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["keep"]);
  });

  it("hides a pi fork whose parent is listed too", () => {
    const rows = topLevelSessions([
      session("parent", null, 20, "pi"),
      session("fork", "parent", 10, "pi"),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["parent"]);
  });

  it("hides the subagents a claude session started", () => {
    // Claude Code keeps a subagent's transcript in a directory beside the session's, and those rows now
    // come back carrying the session as their parent (see `agent_sessions::claude`). They are what the
    // manage view shows; the list the user resumes from is not the place for a helper's run.
    const rows = topLevelSessions([
      session("s1", null, 30, "claude"),
      session("abc", "s1", 20, "claude"),
      session("def", "s1", 10, "claude"),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["s1"]);
  });

  it("handles an empty list", () => {
    expect(topLevelSessions([])).toEqual([]);
  });
});