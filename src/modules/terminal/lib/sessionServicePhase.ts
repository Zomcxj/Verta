/**
 * What the opencode service says about the session a tab is showing, as a phase.
 *
 * The screen judge in `agentJudge.ts` reads the bottom of a terminal and infers whether work is in
 * flight. It is the only source there is for an agent started by hand, but for a session opened
 * from the list there is something better: opencode runs a service that holds its sessions and
 * stamps both `busy` (when the current turn started) and `idle` (when the last one ended), so the
 * service can be asked instead of guessed at. This module is the join that makes that answer usable
 * per tab: the tab says which session it resumed, the service says whether that session is
 * mid-turn, and the store is keyed by pty.
 *
 * It is deliberately narrow. A tab that was not opened from the session list carries no session id,
 * and nothing here invents one: those tabs keep the judge they always had. The value is that the
 * sessions the user actually returns to - the ones in the list - stop being inferred from a footer.
 */

/** One tab's claim: the session it resumed and the ptys its leaves are showing. */
export type SessionTabClaim = {
  readonly sessionId: string;
  readonly ptys: readonly number[];
};

/**
 * Group tabs into "this session is being shown by these ptys", skipping tabs that are not sessions.
 *
 * One session can be shown by more than one pty after a split, and the ptys are unioned rather than
 * replaced so the second tab cannot drop the first one's leaf.
 */
export function collectSessionClaims(
  tabs: readonly { kind: string; sessionId?: string; ptys: readonly number[] }[],
): SessionTabClaim[] {
  const bySession = new Map<string, number[]>();
  for (const tab of tabs) {
    const sessionId = tab.sessionId;
    if (tab.kind !== "terminal" || sessionId === undefined) continue;
    const ptys = bySession.get(sessionId) ?? [];
    for (const ptyId of tab.ptys) {
      if (!ptys.includes(ptyId)) ptys.push(ptyId);
    }
    bySession.set(sessionId, ptys);
  }
  return [...bySession].map(([sessionId, ptys]) => ({ sessionId, ptys }));
}

/**
 * The ptys the service is entitled to correct, and what it says about each.
 *
 * Only the positive direction. The service is asked whether a session is mid-turn, and when it
 * says yes that is work in flight, which the screen may be missing - a footer the rules do not
 * recognise reads as nothing at all, and that is how a session sitting at its prompt was once
 * drawn orange. When the service says no, the screen keeps its word: the service writes its stamps
 * when a turn opens and closes, so for the seconds between them a session that has just started
 * work still reads as idle there, and the screen is the fresher of the two.
 *
 * `running` is `null` when the service could not be asked at all - not installed, not running, no
 * service file - and then nothing is corrected, which is the behaviour before this existed.
 */
export function sessionsRunningNow(
  claims: readonly SessionTabClaim[],
  running: ReadonlySet<string> | null,
): { ptyId: number; sessionId: string }[] {
  if (running === null) return [];
  const answer: { ptyId: number; sessionId: string }[] = [];
  for (const claim of claims) {
    if (!running.has(claim.sessionId)) continue;
    for (const ptyId of claim.ptys) answer.push({ ptyId, sessionId: claim.sessionId });
  }
  return answer;
}
