import {
  type AgentPhase,
  tabAgentStatus,
} from "@/modules/terminal/lib/agentActivity";
import type { AgentStateDot } from "@/modules/terminal/AgentStateDot";
import { leafIds } from "@/modules/terminal";
import { ptyIdsForLeaves } from "@/modules/tabs/lib/tabAgentStatus";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import type { AgentTool } from "./types";

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
 * How recently a session must have been written to for the list to call it active, per tool.
 *
 * A session nobody has a tab open for is still doing something, and nothing else names it cheaply:
 * an `opencode` started without `--session` carries no session id in its command line, and one
 * hosted by the background service carries none at all. What is available is when the session's
 * store was last written - the same number the row already shows as "last talked" - and writes only
 * happen while something is going on.
 *
 * The window is measured rather than guessed: polling sessions that were running on this machine,
 * the gap between one write and the next was 5 to 35 seconds with a median near 10, and the longest
 * single gap inside a turn was 129 seconds on an `opencode` session and 123 on a `pi` one. Three
 * minutes covers those with room to spare.
 *
 * Both tools share one window because that measurement says they behave alike. An earlier reading
 * gave `pi` a wider one, taken from the timestamps inside its session file - but pi stamps a
 * message with the time its turn *started*, so those gaps only ever grow and said nothing about how
 * often it writes. Measured by watching the file itself, pi writes at the same rhythm as opencode.
 *
 * A tool nobody has measured keeps this window too: a dot that is missing is a smaller lie than one
 * drawn on a guess.
 */
export const ACTIVE_WINDOW_BY_TOOL: Readonly<Record<AgentTool, number>> = {
  opencode: 3 * 60_000,
  pi: 3 * 60_000,
  claude: 3 * 60_000,
};

/**
 * How often the list re-answers "is anything still recent" with nobody writing.
 *
 * Writes stop silently, so nothing pushes an update when a session finishes; without a slow tick the
 * last mark would stay lit until something else changed. Twenty seconds is often enough to look
 * prompt and rare enough to be free - no queries, just a re-render.
 */
export const ACTIVE_TICK_MS = 20_000;

/**
 * Sessions written to inside their tool's window, by id. A subagent's write counts for its parent.
 *
 * The subagent has no row of its own while the list is not in managing mode, so a mark on it would
 * be a mark nobody sees - and the parent is not a substitute for it in the other direction: measured
 * on this machine, a Claude Code parent waiting on three subagents wrote nothing to its own
 * transcript for minutes while the children wrote every few seconds, so a window that only looked at
 * the parent's own file called the whole of that work idle.
 *
 * The two times a row carries can disagree, and the later one is the one that happened last: pi
 * stamps a message with the time its turn *started* and appends it when the turn ends, so its
 * message time can sit minutes behind the file's own last-write time. Reading only the first would
 * call an agent idle in the middle of a turn it was plainly working on. A time in the future counts
 * as active - the alternative is a negative age that silently excludes it forever.
 */
export function activeByWindow(
  sessions: readonly {
    id: string;
    parentId: string | null;
    tool: AgentTool;
    lastAtMs?: number | null;
    updatedAtMs?: number;
  }[],
  now: number,
  windows: Readonly<Record<AgentTool, number>>,
): Set<string> {
  const active = new Set<string>();
  const parentsWithFreshChild = new Set<string>();
  for (const session of sessions) {
    const talked = session.lastAtMs ?? null;
    const touched = session.updatedAtMs ?? null;
    const last = talked === null ? touched : touched === null ? talked : Math.max(talked, touched);
    if (last === null) continue;
    const window = windows[session.tool];
    if (window === undefined || now - last >= window) continue;
    if (session.parentId === null) active.add(session.id);
    else parentsWithFreshChild.add(session.parentId);
  }
  for (const parentId of parentsWithFreshChild) active.add(parentId);
  return active;
}

/**
 * The two readings of "something is happening here", with the service settling opencode's side.
 *
 * The service is authoritative and complete for opencode: `GET /api/session/active` answers
 * "sessions absent from the result are inactive", so for an opencode session its silence is a
 * statement, not a gap. That has to beat the write times in both directions - they go quiet during a
 * long tool call (measured here, a turn wrote nothing for eight and a half minutes), and they also
 * light up for writes that are not a turn at all (measured here, a session whose turn had ended kept
 * having `updated` rewritten, and the three-minute window drew "后台有 agent 在跑" for it on every
 * look, with no tab open to check it against).
 *
 * Claude Code answers the same way from its own runtime registry: a session is busy or it is not,
 * and a session that is not in the registry is not running - which is what turns a row dark the
 * moment a turn ends instead of three minutes later (`claude_status` on the Rust side reads it).
 *
 * Every other tool is left to the write window: `pi` has no equivalent service, so the caller passes
 * which ids belong to which tool rather than expecting this to know.
 *
 * Each tool's field is `null` when that question could not be asked at all (no opencode service, a
 * Claude Code without a registry). That tool's rows then keep their write time, so a source that is
 * not there cannot empty the list of marks - and the other tool is unaffected.
 */
export type RunningByTool = {
  opencode: ReadonlySet<string> | null;
  claude: ReadonlySet<string> | null;
};

export function activeWithService(
  fromWrites: ReadonlySet<string>,
  running: RunningByTool | null,
  opencodeIds: ReadonlySet<string>,
  claudeIds: ReadonlySet<string>,
): Set<string> {
  const opencode = running?.opencode ?? null;
  const claude = running?.claude ?? null;
  // Whether a row's own tool answered for it. A row whose tool said nothing keeps its writes.
  const settled = (id: string) =>
    (opencode !== null && opencodeIds.has(id)) ||
    (claude !== null && claudeIds.has(id));
  const active = new Set<string>();
  for (const id of fromWrites) {
    if (!settled(id)) active.add(id);
  }
  for (const id of opencode ?? []) active.add(id);
  for (const id of claude ?? []) active.add(id);
  return active;
}
