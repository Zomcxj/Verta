import type { AgentSession } from "./types";

/**
 * Subagent sessions are not shown: the list answers "continue what I was doing",
 * and a subagent run is not something the user resumes directly.
 *
 * The two tools need different rules because they keep their data differently:
 *
 * - opencode stores a parent id, and deleting a parent takes its children with
 *   it, so a non-null parent always means "a child that still has a parent".
 *   Its query is also capped, so a child can appear without its parent in the
 *   window; hiding that one would make a session vanish for a reason unrelated
 *   to the user, so it stays.
 * - a pi fork records the parent's *file path*. The parent transcript can be
 *   deleted while the fork stays on disk (this machine has exactly that: a
 *   `subagent-worker-*` fork whose parent is gone). A fork is never something
 *   the user opened, so it is hidden whether or not its parent is still listed.
 */
export function topLevelSessions(sessions: AgentSession[]): AgentSession[] {
  const present = new Set(sessions.map((session) => session.id));
  return sessions.filter((session) => {
    const parentId = session.parentId;
    // A self-reference is corrupt data, not a real parent.
    if (parentId === null || parentId === session.id) return true;
    if (session.tool === "pi") return false;
    return !present.has(parentId);
  });
}