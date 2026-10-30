import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

export type AgentPhase = "working" | "attention" | "finished" | "idle";

/** The kinds a signal can carry, as the store's own vocabulary. */
export type AgentSignalKind =
  | "started"
  | "working"
  | "attention"
  | "finished"
  | "idle"
  | "exited";

export type AgentSignal = {
  id: number;
  kind: AgentSignalKind;
  agent?: string | null;
};

type AgentActivityStore = {
  phases: Record<number, AgentPhase>;
  // pty -> agent name, learned from the `started` signal and kept until exit so
  // the tab can show that agent's brand icon while it runs.
  agents: Record<number, string>;
  /**
   * pty -> when it started waiting on the user, for attention the user has not
   * looked at yet. This is the latch the tab's own marker and the notification
   * layers read: it is *not* the live phase, which stays `attention` for as long as
   * the agent really is blocked, however often the user looks at the tab.
   */
  unseen: Record<number, number>;
  /**
   * pty -> when its turn ended, for an ending the user has not looked at yet.
   *
   * The second latch, and the same shape as `unseen`: a turn that ended stays ended, so the state
   * alone cannot say whether it is news, and this is what makes the difference between the green
   * dot ("this just finished and you have not seen it") and the orange one ("there is an agent
   * here"). Cleared by looking at the tab, and by the next turn starting there.
   */
  unseenDone: Record<number, number>;
  /** The leaves of the tab the user is on, so "the user is looking at it" is a fact. */
  foregroundLeaves: ReadonlySet<number>;
  /**
   * leaf -> pty. The tab strip finds a tab's ptys through this, and it has to come
   * from the store rather than from the session registry: a state dot appears when
   * the store changes, and a registry read at render time would only ever be as
   * fresh as the last render that happened for some other reason.
   */
  leafPty: Record<number, number>;
  setPhase: (id: number, phase: AgentPhase) => void;
  setAgent: (id: number, agent: string) => void;
  setLeafPty: (leafId: number, ptyId: number) => void;
  clearLeafPty: (leafId: number) => void;
  /** Tell the store which leaves the user is looking at. */
  setForegroundLeaves: (ids: readonly number[]) => void;
  /** The user has looked at these sessions: their waiting is no longer unseen. */
  markAttentionSeen: (ids: readonly number[]) => void;
  /** Record that a session started waiting while the user was not looking at it. */
  markAttentionUnseen: (id: number, atMs: number) => void;
  /** The user has looked at these sessions: a turn that ended is no longer unseen either. */
  markDoneSeen: (ids: readonly number[]) => void;
  /** Record that a session's turn ended while the user was not looking at it. */
  markDoneUnseen: (id: number, atMs: number) => void;
  clear: (id: number) => void;
};

/** One shared empty set: a store with no foreground tab must not allocate per write. */
const EMPTY_FOREGROUND: ReadonlySet<number> = new Set();

/**
 * Whether a session is one the user is looking at, through the leaf it lives in.
 *
 * The foreground is a set of leaves (the ones the active tab owns) while sessions
 * are keyed by pty, so this walks the leaf map, which is at most a handful of panes.
 */
export function isForegroundPty(
  leafPty: Record<number, number>,
  foregroundLeaves: ReadonlySet<number>,
  ptyId: number,
): boolean {
  for (const leafId of foregroundLeaves) {
    if (leafPty[leafId] === ptyId) return true;
  }
  return false;
}

export const useAgentActivityStore = create<AgentActivityStore>((set) => ({
  phases: {},
  agents: {},
  leafPty: {},
  unseen: {},
  unseenDone: {},
  foregroundLeaves: EMPTY_FOREGROUND,
  setPhase: (id, phase) =>
    set((s) => {
      if (s.phases[id] === phase) return s;
      return { phases: { ...s.phases, [id]: phase } };
    }),
  setAgent: (id, agent) =>
    set((s) => {
      if (s.agents[id] === agent) return s;
      return { agents: { ...s.agents, [id]: agent } };
    }),
  setLeafPty: (leafId, ptyId) =>
    set((s) => {
      if (s.leafPty[leafId] === ptyId) return s;
      return { leafPty: { ...s.leafPty, [leafId]: ptyId } };
    }),
  clearLeafPty: (leafId) =>
    set((s) => {
      if (!(leafId in s.leafPty)) return s;
      const leafPty = { ...s.leafPty };
      delete leafPty[leafId];
      return { leafPty };
    }),
  setForegroundLeaves: (ids) =>
    set((s) => {
      const next = new Set(ids);
      if (
        next.size === s.foregroundLeaves.size &&
        [...next].every((id) => s.foregroundLeaves.has(id))
      ) {
        return s;
      }
      return { foregroundLeaves: next };
    }),
  markAttentionSeen: (ids) =>
    set((s) => {
      let unseen: Record<number, number> | null = null;
      for (const id of ids) {
        if (!(id in s.unseen)) continue;
        unseen ??= { ...s.unseen };
        delete unseen[id];
      }
      return unseen ? { unseen } : s;
    }),
  markAttentionUnseen: (id, atMs) =>
    set((s) => {
      // A session that keeps waiting does not restart its latch: the moment it
      // started waiting is what the notification layers sort on.
      if (id in s.unseen) return s;
      return { unseen: { ...s.unseen, [id]: atMs } };
    }),
  markDoneSeen: (ids) =>
    set((s) => {
      let unseenDone: Record<number, number> | null = null;
      for (const id of ids) {
        if (!(id in s.unseenDone)) continue;
        unseenDone ??= { ...s.unseenDone };
        delete unseenDone[id];
      }
      return unseenDone ? { unseenDone } : s;
    }),
  markDoneUnseen: (id, atMs) =>
    set((s) => {
      // An ending already waiting to be seen is not news again for the turn after it: the
      // earliest one is what the user has not looked at.
      if (id in s.unseenDone) return s;
      return { unseenDone: { ...s.unseenDone, [id]: atMs } };
    }),
  clear: (id) =>
    set((s) => {
      const known =
        id in s.phases ||
        id in s.agents ||
        id in s.unseen ||
        id in s.unseenDone;
      if (!known) return s;
      const phases = { ...s.phases };
      const agents = { ...s.agents };
      const unseen = { ...s.unseen };
      const unseenDone = { ...s.unseenDone };
      delete phases[id];
      delete agents[id];
      delete unseen[id];
      delete unseenDone[id];
      return { phases, agents, unseen, unseenDone };
    }),
}));

const FINISHED_TTL_MS = 6000;

const finishedTimers = new Map<number, ReturnType<typeof setTimeout>>();

function clearFinishedTimer(id: number): void {
  const t = finishedTimers.get(id);
  if (t) {
    clearTimeout(t);
    finishedTimers.delete(id);
  }
}

let listenerReady: Promise<void> | null = null;

export function clearAgentActivity(id: number): void {
  clearFinishedTimer(id);
  useAgentActivityStore.getState().clear(id);
}

/** Maps a raw detector signal to the phase it drives, `"exited"` to drop the
 * pty, or `null` to ignore. Pure so the mapping stays unit-testable. */
export function phaseForSignal(kind: string): AgentPhase | "exited" | null {
  switch (kind) {
    case "started":
    case "working":
      return "working";
    case "attention":
      return "attention";
    case "finished":
      return "finished";
    case "idle":
      return "idle";
    case "exited":
      return "exited";
    default:
      return null;
  }
}

type AgentSignalHandler = (signal: AgentSignal) => void;
const signalHandlers = new Set<AgentSignalHandler>();

/**
 * Subscribes to every raw detector signal through the single shared native
 * `verta:agent-signal` listener (the activity store has already applied the
 * signal when handlers run). One listener serves the tab icons and the
 * notification bridge instead of one IPC subscription each.
 */
export function subscribeAgentSignals(handler: AgentSignalHandler): () => void {
  signalHandlers.add(handler);
  void ensureAgentActivityListener().catch(() => {});
  return () => {
    signalHandlers.delete(handler);
  };
}

/**
 * Applies one signal to the store (and starts the "finished" timer it may carry).
 *
 * Exported for the front-end judge, which produces signals of the same shape as
 * the native detector: one place applies a signal, so a state dot, the store and
 * the notification bridge can never disagree about what a signal means.
 */
export function applySignal(payload: AgentSignal): void {
  const { id, agent } = payload;
  const action = phaseForSignal(payload.kind);
  if (action === null) return;
  clearFinishedTimer(id);
  const store = useAgentActivityStore.getState();
  if (action === "exited") {
    store.clear(id);
    return;
  }
  // The agent name only rides the `started` signal (incl. self-arm).
  if (agent) store.setAgent(id, agent);
  store.setPhase(id, action);
  if (action === "attention") {
    // Recorded wherever the session is drawn, including the tab the user is looking at. "Waiting
    // for an answer" is a state the user acts on, so it stays counted until the answer is given -
    // the phase leaving `attention` is what clears it, not the tab being in front. Clearing it on
    // sight made the count honest about "not seen" and useless about "still unanswered": a question
    // on the active tab was counted for one tick and then vanished while still on screen.
    store.markAttentionUnseen(id, Date.now());
  } else {
    // Anything else means the wait is over (the user answered, or the turn went on),
    // so a latch from before must not outlive it.
    store.markAttentionSeen([id]);
  }
  if (action === "finished") {
    // The turn ended while nobody was looking at that tab: that is the one thing the window says
    // in the colour that means "you have not seen this", and it keeps saying it until the user is
    // on the tab or the next turn starts there.
    if (!isForegroundPty(store.leafPty, store.foregroundLeaves, id)) {
      store.markDoneUnseen(id, Date.now());
    }
    finishedTimers.set(
      id,
      setTimeout(() => {
        finishedTimers.delete(id);
        const s = useAgentActivityStore.getState();
        if (s.phases[id] === "finished") s.setPhase(id, "idle");
      }, FINISHED_TTL_MS),
    );
  } else if (action === "working") {
    // The next turn started: whatever ended before it is no longer the news on that session.
    store.markDoneSeen([id]);
  }
}

// The Rust detector arms via the Claude Code / Codex / Gemini OSC 777 marker and
// reports per-pty lifecycle: started, working, attention, finished, exited.
export function ensureAgentActivityListener(): Promise<void> {
  if (listenerReady) return listenerReady;
  listenerReady = listen<AgentSignal>("verta:agent-signal", (e) => {
    applySignal(e.payload);
    for (const handler of signalHandlers) {
      try {
        handler(e.payload);
      } catch (error) {
        console.error("[verta] agent signal handler failed:", error);
      }
    }
  }).then(
    () => {},
    (error: unknown) => {
      listenerReady = null;
      throw error;
    },
  );
  return listenerReady;
}

export function isAgentActivePty(ptyId: number): boolean {
  return ptyId in useAgentActivityStore.getState().phases;
}

/**
 * Whether the agent on this leaf is busy: running a turn, or waiting on an answer.
 *
 * The close guards ask this beside the shell's "has a child process" query, because that
 * query cannot see an agent this app launched: Windows records a process's parent when
 * the process is created, and an agent started through a launcher that exits immediately
 * is recorded against a pid that no longer exists (measured on this machine, see
 * `scripts/dev/probes/process-tree.ps1`). So the screen is the tie-breaker, and it is also
 * the only instrument that can say whether the agent is *doing* something: the query only
 * says a process exists.
 *
 * An agent sitting at its prompt is deliberately not busy. Its session is resumable from
 * the session list, and the query still reports the process it left behind, so nothing
 * that would have warned stops warning.
 */
export function isLeafAgentBusy(leafId: number): boolean {
  const { leafPty, phases } = useAgentActivityStore.getState();
  const ptyId = leafPty[leafId];
  if (ptyId === undefined) return false;
  const phase = phases[ptyId];
  return phase === "working" || phase === "attention";
}

/** What a phase change is worth flashing the taskbar button for, if anything. */
export type AgentFlash = "ask" | "done" | null;

/**
 * The taskbar flash rule, as a function of one phase change.
 *
 * It is here rather than inside the hook so it can be tested: the hook's own effect needs a
 * window, an IPC bridge and a taskbar to observe, while this is the whole decision.
 *
 * - `finished` is the judge saying an agent that was working has stopped painting work.
 *   That is the "done" moment, and it is the phase itself rather than a guess about
 *   silence: a turn waiting on a slow tool is silent for minutes without being finished.
 * - `attention` is a question an agent is waiting on, but only while the user has not
 *   looked at it. The store's latch is what says so, and a tab the user is on never
 *   latches: being on screen is being seen. It is judged by that latch rather than by the
 *   phase changing, because the store writes the phase first and the latch a moment later
 *   in a second write (measured): by the time a wait is knowable, its phase has already
 *   moved, so a rule keyed on the phase changing misses every wait there is. Telling one
 *   wait from the next, and telling each of them exactly once, is the caller's job - it is
 *   the caller that remembers the latch it has already acted on.
 */
export function flashForPhaseChange(
  previous: AgentPhase | undefined,
  phase: AgentPhase | undefined,
  unseenSinceMs: number | undefined,
): AgentFlash {
  if (phase === "attention") return unseenSinceMs === undefined ? null : "ask";
  if (phase === previous) return null;
  if (phase === "finished") return "done";
  return null;
}

export type AgentPhaseCounts = {
  /** Sessions waiting on the user. */
  attention: number;
  /** Sessions with a turn in flight. */
  working: number;
};

/**
 * How many sessions are waiting on the user and how many are working, across every
 * terminal in the window. The tab strip answers "which one", this answers "how
 * many", which is what is worth showing when the tabs themselves are out of view.
 */
export function countAgentPhases(
  phases: Record<number, AgentPhase>,
): AgentPhaseCounts {
  let attention = 0;
  let working = 0;
  for (const phase of Object.values(phases)) {
    if (phase === "attention") attention += 1;
    else if (phase === "working") working += 1;
  }
  return { attention, working };
}

/**
 * One tab's agent status.
 *
 * The three states the window draws, and what each one is for: `attention` for a question, which
 * is the one thing that has to reach the user wherever they are looking; `finished` for a turn
 * that ended and that the user has not looked at yet, which is news and is why it is the one
 * state that goes away by itself; and `working` for everything else with an agent on it - a turn
 * in flight, and a session sitting at its prompt, which read the same because a session that has
 * just been opened has ended no turn and has nothing to say beyond "there is an agent here".
 *
 * An agent sitting at its prompt keeps its name, so the tab keeps the brand icon, and a shell
 * with no agent on it is not a state at all.
 */
export type AgentTabStatus = {
  state: "attention" | "working" | "idle" | "finished" | null;
  agent: string | null;
};

/**
 * Highest-severity state across the tab's ptys wins: attention > an ending the user has not seen
 * > work in flight > an agent at its prompt.
 *
 * The ending is read from the latch rather than from the phase, because that is what makes it
 * news: the phase settles to `idle` a few seconds after the turn ends, while "you have not looked
 * at this" is only true until the user is on that tab, which is when the latch is cleared.
 */
export function tabAgentStatus(
  phases: Record<number, AgentPhase>,
  agents: Record<number, string>,
  ptyIds: readonly number[],
  unseenDone: Record<number, number>,
): AgentTabStatus {
  let attention = false;
  let ended = false;
  let working = false;
  let resting = false;
  let agentName: string | null = null;
  for (const id of ptyIds) {
    const agent = agents[id] ?? null;
    const phase = phases[id];
    if (agent !== null) agentName ??= agent;
    if (phase === "attention") {
      attention = true;
      continue;
    }
    if (id in unseenDone) {
      ended = true;
      continue;
    }
    if (phase === "working") {
      working = true;
      continue;
    }
    // At rest: an agent with no turn in flight. A shell with no agent on it has no state at all,
    // which is why this one asks for the name and the two above do not.
    if (agent !== null) resting = true;
  }
  if (attention) return { state: "attention", agent: null };
  if (ended) return { state: "finished", agent: agentName };
  if (working) return { state: "working", agent: agentName };
  if (resting) return { state: "idle", agent: agentName };
  return { state: null, agent: null };
}
