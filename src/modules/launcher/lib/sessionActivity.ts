import {
  type AgentPhase,
  tabAgentStatus,
} from "@/modules/terminal/lib/agentActivity";
import type { AgentStateDot } from "@/modules/terminal/AgentStateDot";
import { leafIds } from "@/modules/terminal";
import { ptyIdsForLeaves } from "@/modules/tabs/lib/tabAgentStatus";
import type { Tab } from "@/modules/tabs/lib/useTabs";

/**
 * What the session list shows about the sessions that are running right now.
 *
 * The list is a list of *stored* sessions while the activity store is keyed by
 * pty, so the two are joined by the tab that resumed the session: a tab opened
 * from this list remembers the session id it was opened for, and its leaves hold
 * the ptys the state comes from. A session nobody has open has no tab and so no
 * state, which is the honest answer: nothing is running for it.
 */

type Input = {
  tabs: readonly Tab[];
  /** leaf -> pty, as the activity store keeps it. */
  leafPty: Record<number, number>;
  phases: Record<number, AgentPhase>;
  agents: Record<number, string>;
};

/**
 * One session id to one state, for every session that is running in a tab.
 *
 * The id alone keys this rather than the list's own key: the two tools mint ids
 * in different shapes and a tab does not know which store its session came from,
 * so two stores minting the same id is the one case this would confuse. Ids are
 * the tools' own unique ids, so that is not a case worth carrying a source
 * through the whole tab model for.
 */
export function sessionStateById({
  tabs,
  leafPty,
  phases,
  agents,
}: Input): Map<string, AgentStateDot> {
  const ptysBySession = new Map<string, number[]>();
  for (const tab of tabs) {
    if (tab.kind !== "terminal" || tab.sessionId === undefined) continue;
    const ptys = ptyIdsForLeaves({ leafPty }, leafIds(tab.paneTree));
    if (ptys.length === 0) continue;
    const known = ptysBySession.get(tab.sessionId);
    if (known) known.push(...ptys);
    else ptysBySession.set(tab.sessionId, ptys);
  }

  const out = new Map<string, AgentStateDot>();
  for (const [sessionId, ptys] of ptysBySession) {
    // The same fold the tab strip uses: the loudest state across a session's
    // panes wins, so one session can never read two ways in one window.
    const state = tabAgentStatus(phases, agents, ptys).state;
    if (state !== null) out.set(sessionId, state);
  }
  return out;
}

/**
 * Sessions waiting on the user first, everything else in the order it arrived.
 *
 * Stable on purpose: the list is otherwise strictly newest-first, and a session
 * that is waiting is the one thing the user has to act on, so it earns the top
 * without reshuffling anything else.
 */
export function waitingFirst<T extends { id: string }>(
  sessions: readonly T[],
  stateById: ReadonlyMap<string, AgentStateDot>,
): readonly T[] {
  let waiting = 0;
  for (const session of sessions) {
    if (stateById.get(session.id) === "attention") waiting += 1;
  }
  if (waiting === 0) return sessions;
  const out: T[] = [];
  for (const session of sessions) {
    if (stateById.get(session.id) === "attention") out.push(session);
  }
  for (const session of sessions) {
    if (stateById.get(session.id) !== "attention") out.push(session);
  }
  return out;
}