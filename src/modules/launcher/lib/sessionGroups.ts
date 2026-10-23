import type { AgentSession, AgentTool } from "./types";

/**
 * How the session list is laid out: `all` keeps one block sorted by time, `tool` splits
 * it into one section per agent.
 *
 * `all` is the default: most of the time people just want "what did I talk about
 * recently", and splitting by agent only means more scanning. Switch to `tool` when
 * actually looking for a specific tool.
 */
export type SessionGroupBy = "all" | "tool";

/** Newest first — both groupings honor it, so switching between them never reorders. */
export function sortByRecent(sessions: readonly AgentSession[]): AgentSession[] {
  return [...sessions].sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

export type SessionGroup = {
  /** `null` is the single-block group (no heading drawn); otherwise it is one agent. */
  tool: AgentTool | null;
  sessions: AgentSession[];
};

/**
 * Split into per-agent sections.
 *
 * Section order follows `tools` (the tool order fixed in settings), not session
 * counts or timestamps — otherwise one new message would reshuffle the whole list.
 * Tools with no sessions **do not appear**, and an empty list yields one empty
 * section so the list's own empty-state copy still shows.
 */
export function groupByTool(
  sessions: readonly AgentSession[],
  tools: readonly AgentTool[],
  groupBy: SessionGroupBy,
): SessionGroup[] {
  if (groupBy === "all") {
    return [{ tool: null, sessions: sortByRecent(sessions) }];
  }
  const known = new Set<string>(tools);
  const groups: SessionGroup[] = tools.map((tool) => ({
    tool,
    sessions: sortByRecent(sessions.filter((session) => session.tool === tool)),
  }));
  // An unknown tool name turned up in storage: list it anyway rather than silently
  // swallowing it.
  const others = sessions.filter((session) => !known.has(session.tool));
  if (others.length > 0) {
    groups.push({ tool: null, sessions: sortByRecent(others) });
  }
  const nonEmpty = groups.filter((group) => group.sessions.length > 0);
  if (nonEmpty.length === 0) return [{ tool: tools[0] ?? null, sessions: [] }];
  return nonEmpty;
}
