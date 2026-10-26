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
  clear: (id) =>
    set((s) => {
      const known = id in s.phases || id in s.agents || id in s.unseen;
      if (!known) return s;
      const phases = { ...s.phases };
      const agents = { ...s.agents };
      const unseen = { ...s.unseen };
      delete phases[id];
      delete agents[id];
      delete unseen[id];
      return { phases, agents, unseen };
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
    // Waiting while the user is looking at the session is not something to be
    // flagged about later; waiting anywhere else is the thing the ring and the
    // notification centre exist for.
    if (!isForegroundPty(store.leafPty, store.foregroundLeaves, id)) {
      store.markAttentionUnseen(id, Date.now());
    }
  } else {
    // Anything else means the wait is over (the user answered, or the turn went on),
    // so a latch from before must not outlive it.
    store.markAttentionSeen([id]);
  }
  if (action === "finished") {
    finishedTimers.set(
      id,
      setTimeout(() => {
        finishedTimers.delete(id);
        const s = useAgentActivityStore.getState();
        if (s.phases[id] === "finished") s.setPhase(id, "idle");
      }, FINISHED_TTL_MS),
    );
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
 *   latches: being on screen is being seen.
 * - Anything else, and anything unchanged, is not news.
 */
export function flashForPhaseChange(
  previous: AgentPhase | undefined,
  phase: AgentPhase | undefined,
  unseen: boolean,
): AgentFlash {
  if (phase === previous) return null;
  if (phase === "finished") return "done";
  if (phase === "attention" && unseen) return "ask";
  return null;
}

export type AgentPhaseCounts = {
  /** Sessions waiting on the user. */
  attention: number;
  /** Sessions with a turn in flight. */
  working: number;
};

/** How many sessions are waiting on the user that the user has not looked at yet. */
export function countUnseenAttention(unseen: Record<number, number>): number {
  return Object.keys(unseen).length;
}

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

export type AgentTabStatus = {
  state: "attention" | "working" | "finished" | "idle" | null;
  // The running agent's name when its brand icon should be shown.
  agent: string | null;
};

// Highest-severity phase across the tab's ptys wins: attention > working >
// finished > idle. Surface an agent name for working and acknowledged idle
// sessions so the tab keeps the active agent's brand icon.
export function tabAgentStatus(
  phases: Record<number, AgentPhase>,
  agents: Record<number, string>,
  ptyIds: readonly number[],
): AgentTabStatus {
  let attention = false;
  let working = false;
  let finished = false;
  let idle = false;
  let workingAgent: string | null = null;
  let idleAgent: string | null = null;
  for (const id of ptyIds) {
    const phase = phases[id];
    if (phase === "attention") attention = true;
    else if (phase === "working") {
      working = true;
      workingAgent ??= agents[id] ?? null;
    } else if (phase === "finished") finished = true;
    else if (phase === "idle") {
      const agent = agents[id];
      if (agent) {
        idle = true;
        idleAgent ??= agent;
      }
    }
  }
  if (attention) return { state: "attention", agent: null };
  if (working) return { state: "working", agent: workingAgent };
  if (finished) return { state: "finished", agent: null };
  if (idle) return { state: "idle", agent: idleAgent };
  return { state: null, agent: null };
}
