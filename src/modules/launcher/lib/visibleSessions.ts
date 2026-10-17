import type { AgentSession } from "./types";

/**
 * Subagent sessions are not shown: the list answers "continue what I was doing",
 * and a subagent run is not something the user resumes directly.
 *
 * A child is only hidden when its parent is in the list too. The opencode query
 * is capped, so a child can outlive its parent in the window; dropping it then
 * would make a session disappear for a reason that has nothing to do with the
 * user.
 */
export function topLevelSessions(sessions: AgentSession[]): AgentSession[] {
  const present = new Set(sessions.map((session) => session.id));
  return sessions.filter((session) => {
    const parentId = session.parentId;
    // A self-reference is corrupt data, not a real parent.
    if (parentId === null || parentId === session.id) return true;
    return !present.has(parentId);
  });
}
