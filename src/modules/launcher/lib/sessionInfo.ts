import type { AgentSession } from "./types";

/**
 * The sessions one session started.
 *
 * A subagent row carries its parent's id (opencode's as a `parent_id`, claude's and pi's as the
 * session they were filed under - see `agent_sessions`), so "what did this session start" is a lookup
 * rather than a stored count: the count cannot drift from the rows the manage view draws, because it
 * is the rows.
 *
 * The tool is part of the match. Ids are unique within a tool but nothing stops two tools from using
 * the same string - a chance collision would otherwise list another agent's session as this one's
 * child, which is exactly the kind of claim the dialog exists to avoid.
 */
export function subagentsOf(
  sessions: readonly AgentSession[],
  parent: AgentSession | null,
): AgentSession[] {
  if (parent === null) return [];
  return sessions.filter(
    (session) =>
      session.parentId === parent.id && session.tool === parent.tool,
  );
}

/**
 * The sessions filed under each one, keyed by tool and parent id.
 *
 * Two surfaces need them without a hover to look up first: the manage view's badge, which says how
 * many rows a tick takes along, and the hover card, which names them. Both read this grouping of the
 * same list the list itself draws, so neither can count something the other does not show. Keyed like
 * `subagentsOf`: an id alone is unique only within a tool.
 *
 * The order inside a group is the list's order, which is newest first - the same order the manage
 * view and the dialog draw them in.
 */
export function subagentsByParent(
  sessions: readonly AgentSession[],
): Map<string, readonly AgentSession[]> {
  const byParent = new Map<string, AgentSession[]>();
  for (const session of sessions) {
    if (session.parentId === null) continue;
    const key = parentCountKey(session.tool, session.parentId);
    const siblings = byParent.get(key);
    if (siblings === undefined) byParent.set(key, [session]);
    else siblings.push(session);
  }
  return byParent;
}

/** The key `subagentsByParent` files a session under. */
export function parentCountKey(tool: string, id: string): string {
  // Written as an escape: a NUL cannot occur in either half, so the pair cannot be mistaken for a
  // bare id, and the file stays free of a byte no editor shows.
  return `${tool}\u0000${id}`;
}
