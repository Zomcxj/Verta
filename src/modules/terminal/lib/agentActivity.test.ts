import { beforeEach, describe, expect, it } from "vitest";
import {
  countAgentPhases,
  countUnseenAttention,
  isAgentActivePty,
  isForegroundPty,
  phaseForSignal,
  tabAgentStatus,
  useAgentActivityStore,
} from "./agentActivity";

describe("countAgentPhases", () => {
  it("counts the two states worth showing and ignores the rest", () => {
    expect(
      countAgentPhases({
        1: "attention",
        2: "working",
        3: "attention",
        4: "finished",
        5: "idle",
      }),
    ).toEqual({ attention: 2, working: 1 });
  });

  it("is all zeros for a window with no agents in it", () => {
    expect(countAgentPhases({})).toEqual({ attention: 0, working: 0 });
  });
});

describe("phaseForSignal", () => {
  it("maps lifecycle kinds to phases", () => {
    expect(phaseForSignal("started")).toBe("working");
    expect(phaseForSignal("working")).toBe("working");
    expect(phaseForSignal("attention")).toBe("attention");
    expect(phaseForSignal("finished")).toBe("finished");
    expect(phaseForSignal("idle")).toBe("idle");
    expect(phaseForSignal("exited")).toBe("exited");
  });

  it("ignores unknown kinds", () => {
    expect(phaseForSignal("bogus")).toBeNull();
    expect(phaseForSignal("")).toBeNull();
  });
});

describe("tabAgentStatus", () => {
  it("returns null state for no matching ptys", () => {
    expect(tabAgentStatus({}, {}, [])).toEqual({ state: null, agent: null });
    expect(tabAgentStatus({ 1: "idle" }, {}, [1])).toEqual({
      state: null,
      agent: null,
    });
    expect(tabAgentStatus({ 1: "idle" }, { 1: "codex" }, [1])).toEqual({
      state: "idle",
      agent: "codex",
    });
  });

  it("orders attention > working > finished", () => {
    const phases = { 1: "working", 2: "finished", 3: "attention" } as const;
    expect(tabAgentStatus(phases, {}, [1, 2, 3])).toEqual({
      state: "attention",
      agent: null,
    });
    expect(tabAgentStatus({ 1: "working", 2: "finished" }, {}, [1, 2])).toEqual({
      state: "working",
      agent: null,
    });
    expect(tabAgentStatus({ 1: "finished" }, {}, [1])).toEqual({
      state: "finished",
      agent: null,
    });
  });

  it("surfaces the working agent name for its icon", () => {
    const phases = { 7: "working" } as const;
    expect(tabAgentStatus(phases, { 7: "claude" }, [7])).toEqual({
      state: "working",
      agent: "claude",
    });
  });

  it("surfaces the acknowledged agent name for its icon", () => {
    const phases = { 7: "idle" } as const;
    expect(tabAgentStatus(phases, { 7: "gemini" }, [7])).toEqual({
      state: "idle",
      agent: "gemini",
    });
  });

  it("only considers the given ptyIds", () => {
    const phases = { 1: "attention", 2: "working" } as const;
    expect(tabAgentStatus(phases, { 2: "codex" }, [2])).toEqual({
      state: "working",
      agent: "codex",
    });
  });
});

describe("useAgentActivityStore", () => {
  beforeEach(() =>
    useAgentActivityStore.setState({
      phases: {},
      agents: {},
      leafPty: {},
      unseen: {},
      foregroundLeaves: new Set(),
    }),
  );

  it("keeps a stable reference when the phase is unchanged", () => {
    const { setPhase } = useAgentActivityStore.getState();
    setPhase(1, "working");
    const first = useAgentActivityStore.getState().phases;
    setPhase(1, "working");
    // No churn on repeated identical signals, so subscribers do not re-render.
    expect(useAgentActivityStore.getState().phases).toBe(first);
  });

  it("remembers which pty a leaf is showing, without churn on a repeat", () => {
    const { setLeafPty, clearLeafPty } = useAgentActivityStore.getState();
    setLeafPty(11, 7);
    const first = useAgentActivityStore.getState().leafPty;
    expect(first).toEqual({ 11: 7 });
    // The judge writes this every tick, so an unchanged pair must not allocate.
    setLeafPty(11, 7);
    expect(useAgentActivityStore.getState().leafPty).toBe(first);
    clearLeafPty(11);
    expect(useAgentActivityStore.getState().leafPty).toEqual({});
    // Clearing a leaf that was never there is a no-op, not an empty-map write.
    const empty = useAgentActivityStore.getState().leafPty;
    clearLeafPty(12);
    expect(useAgentActivityStore.getState().leafPty).toBe(empty);
  });

  it("drops a pty's phase, agent and latch on clear", () => {
    const { setPhase, setAgent, markAttentionUnseen, clear } =
      useAgentActivityStore.getState();
    setPhase(1, "attention");
    setAgent(1, "gemini");
    markAttentionUnseen(1, 5_000);
    clear(1);
    const state = useAgentActivityStore.getState();
    expect(1 in state.phases).toBe(false);
    expect(1 in state.agents).toBe(false);
    expect(1 in state.unseen).toBe(false);
  });

  it("keeps the live phase when the user looks at a waiting session", () => {
    // The phase is what the agent is doing; the latch is what the user has not seen.
    // Clearing the latch must not turn a blocked agent into an idle-looking one,
    // because it is still blocked until it is answered.
    const store = useAgentActivityStore.getState();
    store.setPhase(1, "attention");
    store.setAgent(1, "gemini");
    store.markAttentionUnseen(1, 5_000);
    store.markAttentionSeen([1, 2, 3]);
    const state = useAgentActivityStore.getState();
    expect(state.phases).toEqual({ 1: "attention" });
    expect(state.unseen).toEqual({});
    // The tab still reads as waiting, with the agent that is waiting on it.
    expect(isAgentActivePty(1)).toBe(true);
    expect(countAgentPhases(state.phases)).toEqual({
      attention: 1,
      working: 0,
    });
  });

  it("does not restart a latch that is already there", () => {
    const { markAttentionUnseen } = useAgentActivityStore.getState();
    markAttentionUnseen(1, 5_000);
    const first = useAgentActivityStore.getState().unseen;
    markAttentionUnseen(1, 9_000);
    // The moment it started waiting is what the notification layers sort on.
    expect(useAgentActivityStore.getState().unseen).toBe(first);
    expect(useAgentActivityStore.getState().unseen[1]).toBe(5_000);
    expect(countUnseenAttention(first)).toBe(1);
  });

  it("keeps the foreground set stable when it does not change", () => {
    const { setForegroundLeaves } = useAgentActivityStore.getState();
    setForegroundLeaves([11, 12]);
    const first = useAgentActivityStore.getState().foregroundLeaves;
    setForegroundLeaves([12, 11]);
    expect(useAgentActivityStore.getState().foregroundLeaves).toBe(first);
    setForegroundLeaves([11]);
    expect(useAgentActivityStore.getState().foregroundLeaves).not.toBe(first);
  });
});

describe("isForegroundPty", () => {
  it("finds a session through the leaf the user is looking at", () => {
    const leafPty = { 11: 7, 12: 8 };
    expect(isForegroundPty(leafPty, new Set([11]), 7)).toBe(true);
    expect(isForegroundPty(leafPty, new Set([11]), 8)).toBe(false);
    expect(isForegroundPty(leafPty, new Set(), 7)).toBe(false);
  });
});
