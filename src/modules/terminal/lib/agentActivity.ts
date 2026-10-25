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
  acknowledgeAttention: (ids: readonly number[]) => void;
  clear: (id: number) => void;
};

export const useAgentActivityStore = create<AgentActivityStore>((set) => ({
  phases: {},
  agents: {},
  leafPty: {},
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
  acknowledgeAttention: (ids) =>
    set((s) => {
      let phases: Record<number, AgentPhase> | null = null;
      for (const id of ids) {
        if (s.phases[id] !== "attention") continue;
        phases ??= { ...s.phases };
        phases[id] = "idle";
      }
      return phases ? { phases } : s;
    }),
  clear: (id) =>
    set((s) => {
      if (!(id in s.phases) && !(id in s.agents)) return s;
      const phases = { ...s.phases };
      const agents = { ...s.agents };
      delete phases[id];
      delete agents[id];
      return { phases, agents };
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
