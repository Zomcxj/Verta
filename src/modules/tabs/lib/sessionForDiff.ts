/** The part of a tab that says whether it is a terminal carrying a session. */
export type SessionTab = { kind: string; sessionId?: string };

/**
 * Which session a diff's review notes are written for.
 *
 * The active terminal tab when one is active, otherwise the last terminal session seen.
 * A diff tab carries no session of its own, so opening one while an agent is working has
 * to keep pointing at that agent rather than at whichever session was opened last.
 */
export function rememberTerminalSession(
  activeTab: SessionTab | undefined,
  previous: string | null,
): string | null {
  if (activeTab?.kind === "terminal" && activeTab.sessionId) {
    return activeTab.sessionId;
  }
  return previous;
}
