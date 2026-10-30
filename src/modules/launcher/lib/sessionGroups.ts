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

/** Newest first: both groupings honor it, so switching between them never reorders. */
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
 * counts or timestamps, otherwise one new message would reshuffle the whole list.
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

/** One source's block: this machine (`null`) or one distro. */
export type SessionSourceGroup = {
  distro: string | null;
  sections: SessionGroup[];
};

/**
 * Split by source first, then by agent inside each source.
 *
 * The **order of the sources is fixed**: this machine first, then each distro by name. It is not
 * the order the sessions arrive in. Building the groups by walking a time-sorted list made the
 * group order follow whatever happened to be newest, so a distro session written to a second ago
 * lifted the whole WSL block above this machine's - the list appearing to reorder itself for
 * reasons that have nothing to do with the rows in it. Someone who reads the first block as "my
 * work" does not want it to move because a build ran in a container.
 *
 * Inside a source nothing is pinned beyond recency: `groupByTool` keeps the agent sections in
 * their configured order, and each section is newest-first.
 */
export function groupBySource(
  sessions: readonly AgentSession[],
  tools: readonly AgentTool[],
  groupBy: SessionGroupBy,
): SessionSourceGroup[] {
  const bySource = new Map<string, AgentSession[]>();
  for (const session of sessions) {
    const key = session.distro ?? "";
    const bucket = bySource.get(key);
    if (bucket) bucket.push(session);
    else bySource.set(key, [session]);
  }
  // `""` is this machine and sorts before every distro name, which is the order wanted; the
  // explicit comparator keeps it that way whatever a future locale does with `localeCompare`.
  const keys = [...bySource.keys()].sort((left, right) => {
    if (left === right) return 0;
    if (left === "") return -1;
    if (right === "") return 1;
    return left.localeCompare(right);
  });
  const groups = keys.map((key) => ({
    distro: key === "" ? null : key,
    sections: groupByTool(bySource.get(key) ?? [], tools, groupBy),
  }));
  // Nothing to show still needs one empty block, so the list's own empty state has where to draw.
  return groups.length > 0 ? groups : [{ distro: null, sections: groupByTool([], tools, groupBy) }];
}
