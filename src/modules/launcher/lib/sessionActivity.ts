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
  /** The latch that says a turn ended and the user has not looked at it yet. */
  unseenDone: Record<number, number>;
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
  unseenDone,
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
    const state = tabAgentStatus(phases, agents, ptys, unseenDone).state;
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
/**
 * The states above, plus the sessions that have been written to but have no tab.
 *
 * A session that is open in a tab is described by its pty's output, which knows far more than the
 * write times do, so that reading always wins - a question waiting must stay blue rather than be
 * repainted. What this adds is the row that used to say nothing at all: an `opencode` running in
 * somebody's terminal, or one left over from a window that is gone.
 *
 * Subagent sessions are skipped: they write through their parent, so marking them too would light
 * two rows for one agent.
 */
export function backgroundStateById(
  states: ReadonlyMap<string, AgentStateDot>,
  activeIds: ReadonlySet<string>,
  sessions: readonly { id: string; parentId: string | null }[],
): Map<string, AgentStateDot> {
  const out = new Map(states);
  if (activeIds.size === 0) return out;
  for (const session of sessions) {
    if (session.parentId !== null) continue;
    if (out.has(session.id)) continue;
    if (activeIds.has(session.id)) out.set(session.id, "background");
  }
  return out;
}

/**
 * How recently a session must have been written to for the list to call it active.
 *
 * A session nobody has a tab open for is still doing something, and nothing else names it cheaply:
 * an `opencode` started without `--session` carries no session id in its command line, and one
 * hosted by the background service carries none at all. What is available is when the session's
 * messages were last written - the same number the row already shows as "last talked" - and writes
 * only happen while something is going on.
 *
 * The window is measured rather than guessed. Polling three sessions that were generating at the
 * time, the gap between one write and the next was usually 5 to 34 seconds, with a median near 15
 * seconds; the longest gaps were 127 and 141 seconds, a model thinking or running a long tool
 * before it writes again. Three minutes covers those with room to spare, and is still short enough
 * that a session which stopped stops showing soon after.
 */
export const ACTIVE_WINDOW_MS = 3 * 60_000;

/**
 * How often the list re-answers "is anything still recent" with nobody writing.
 *
 * Writes stop silently, so nothing pushes an update when a session finishes; without a slow tick the
 * last mark would stay lit until something else changed. Twenty seconds is often enough to look
 * prompt and rare enough to be free - no queries, just a re-render.
 */
export const ACTIVE_TICK_MS = 20_000;

/**
 * Sessions written to inside the window, by id.
 *
 * Subagent sessions are left out: they write through their parent, so counting them would put a
 * mark on two rows for one piece of work. A time in the future counts as active - the alternative
 * is a negative age that silently excludes it forever.
 */
export function activeByWindow(
  sessions: readonly {
    id: string;
    parentId: string | null;
    lastAtMs?: number | null;
    updatedAtMs?: number;
  }[],
  now: number,
  windowMs: number,
): Set<string> {
  const active = new Set<string>();
  for (const session of sessions) {
    if (session.parentId !== null) continue;
    const last = session.lastAtMs ?? session.updatedAtMs ?? null;
    if (last === null) continue;
    if (now - last < windowMs) active.add(session.id);
  }
  return active;
}
