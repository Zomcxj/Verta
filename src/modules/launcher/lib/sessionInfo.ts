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
