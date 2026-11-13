import type { AgentSession, AgentTool, SessionTarget } from "./types";

/**
 * Selection identity. The two tools mint ids in different shapes, but a key is
 * still qualified by tool and by source so a collision could never select a
 * session the user did not click, and the same id in two stores stays distinct.
 */
export type SessionKey = string & { readonly __sessionKey: unique symbol };

export function sessionKey(
  session: Pick<AgentSession, "tool" | "id" | "distro">,
): SessionKey {
  return `${session.tool}:${session.distro ?? ""}:${session.id}` as SessionKey;
}

/**
 * Is this row the one whose name is being edited in place?
 *
 * The two sides of this question used to be written out separately - the panel stored a key, the
 * list compared it against a bare id - and because those are different strings the rename box was
 * never drawn. The menu item closed and nothing happened. Both sides now go through `sessionKey`,
 * and the branded key type means a bare id no longer type-checks as a stored key.
 */
export function isRenaming(
  renameKey: SessionKey | null | undefined,
  session: Pick<AgentSession, "tool" | "id" | "distro">,
): boolean {
  return renameKey != null && renameKey === sessionKey(session);
}

export type SelectionMode = "all" | "none";

export function toggleSelection(
  selected: ReadonlySet<string>,
  key: string,
): Set<string> {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * Applies select-all / clear to the rows currently on screen, so a selection
 * made under a search term is never silently widened past what the user saw.
 */
export function updateSelection(
  selected: ReadonlySet<string>,
  mode: SelectionMode,
  visibleKeys: string[],
): Set<string> {
  const next = new Set(selected);
  for (const key of visibleKeys) {
    if (mode === "all") next.add(key);
    else next.delete(key);
  }
  return next;
}

export function selectedTargets(
  sessions: AgentSession[],
  selected: ReadonlySet<string>,
): SessionTarget[] {
  return sessions
    .filter((session) => selected.has(sessionKey(session)))
    .map((session) => ({
      tool: session.tool,
      id: session.id,
      distro: session.distro,
    }));
}

export type DeletionSummary = {
  total: number;
  byTool: Record<AgentTool, number>;
  subagents: number;
  hasSubagents: boolean;
};

export function deletionSummary(sessions: AgentSession[]): DeletionSummary {
  const byTool: Record<AgentTool, number> = { opencode: 0, pi: 0, claude: 0 };
  let subagents = 0;
  for (const session of sessions) {
    byTool[session.tool] += 1;
    if (session.parentId !== null) subagents += 1;
  }
  return {
    total: sessions.length,
    byTool,
    subagents,
    hasSubagents: subagents > 0,
  };
}
