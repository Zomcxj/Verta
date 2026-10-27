import { beforeEach, describe, expect, it } from "vitest";
import {
  applySignal,
  countAgentPhases,
  flashForPhaseChange,
  isAgentActivePty,
  isForegroundPty,
  isLeafAgentBusy,
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
  // The latch, as the store keeps it: a turn that ended and the user has not looked at it.
  const DONE = { 2: 1_000 };

  it("returns null state for no matching ptys", () => {
    expect(tabAgentStatus({}, {}, [], {})).toEqual({ state: null, agent: null });
    expect(tabAgentStatus({ 1: "idle" }, {}, [1], {})).toEqual({
      state: null,
      agent: null,
    });
    // An agent at its prompt is a session with an agent on it and no news: orange, not green.
    expect(tabAgentStatus({ 1: "idle" }, { 1: "codex" }, [1], {})).toEqual({
      state: "idle",
      agent: "codex",
    });
  });

  it("orders attention > an ending not yet seen > working > at rest", () => {
    const phases = { 1: "working", 2: "finished", 3: "attention" } as const;
    expect(tabAgentStatus(phases, { 2: "codex" }, [1, 2, 3], DONE)).toEqual({
      state: "attention",
      agent: null,
    });
    expect(
      tabAgentStatus({ 1: "working", 2: "finished" }, { 2: "codex" }, [1, 2], DONE),
    ).toEqual({ state: "finished", agent: "codex" });
    // The same tab, once the user has looked at it: the ending is no longer news.
    expect(
      tabAgentStatus({ 1: "working", 2: "finished" }, { 2: "codex" }, [1, 2], {}),
    ).toEqual({ state: "working", agent: "codex" });
  });

  it("surfaces the working agent name for its icon", () => {
    const phases = { 7: "working" } as const;
    expect(tabAgentStatus(phases, { 7: "claude" }, [7], {})).toEqual({
      state: "working",
      agent: "claude",
    });
  });

  it("surfaces the acknowledged agent name for its icon", () => {
    const phases = { 7: "idle" } as const;
    expect(tabAgentStatus(phases, { 7: "gemini" }, [7], {})).toEqual({
      state: "idle",
      agent: "gemini",
    });
  });

  it("keeps an ending green after the phase settles to idle", () => {
    // The store holds `finished` for a few seconds and then writes `idle`. The latch is what
    // carries the news, so the dot is still green then - and stays green until the user looks.
    expect(tabAgentStatus({ 7: "idle" }, { 7: "gemini" }, [7], { 7: 1_000 })).toEqual({
      state: "finished",
      agent: "gemini",
    });
  });

  it("only considers the given ptyIds", () => {
    const phases = { 1: "attention", 2: "working" } as const;
    expect(tabAgentStatus(phases, { 2: "codex" }, [2], {})).toEqual({
      state: "working",
      agent: "codex",
    });
  });
});

describe("isLeafAgentBusy", () => {
  beforeEach(() =>
    useAgentActivityStore.setState({
      phases: {},
      agents: {},
      leafPty: {},
      unseen: {},
      unseenDone: {},
      foregroundLeaves: new Set(),
    }),
  );

  it("is busy while the agent works and while it waits on an answer", () => {
    const { setLeafPty, setPhase } = useAgentActivityStore.getState();
    setLeafPty(11, 7);
    setPhase(7, "working");
    expect(isLeafAgentBusy(11)).toBe(true);
    setPhase(7, "attention");
    expect(isLeafAgentBusy(11)).toBe(true);
  });

  it("is not busy at the agent's own prompt", () => {
    // An agent sitting at its prompt is resumable from the session list, and the process
    // query still reports the process it left behind.
    const { setLeafPty, setPhase } = useAgentActivityStore.getState();
    setLeafPty(11, 7);
    for (const phase of ["idle", "finished"] as const) {
      setPhase(7, phase);
      expect(isLeafAgentBusy(11)).toBe(false);
    }
  });

  it("says not busy about a leaf with no pty and about an unknown one", () => {
    expect(isLeafAgentBusy(11)).toBe(false);
    useAgentActivityStore.getState().setLeafPty(11, 7);
    expect(isLeafAgentBusy(11)).toBe(false);
    expect(isLeafAgentBusy(12)).toBe(false);
  });
});

describe("flashForPhaseChange", () => {
  it("calls a stop after work done, and a question only while unseen", () => {
    expect(flashForPhaseChange("working", "finished", undefined)).toBe("done");
    expect(flashForPhaseChange("attention", "finished", undefined)).toBe("done");
    expect(flashForPhaseChange("working", "attention", 1_000)).toBe("ask");
    expect(flashForPhaseChange("attention", "working", undefined)).toBe(null);
    expect(flashForPhaseChange("finished", "idle", 1_000)).toBe(null);
    expect(flashForPhaseChange("working", "idle", undefined)).toBe(null);
  });

  it("reads a wait from its latch, even when the phase itself has not moved", () => {
    // Measured: the store writes the phase first and the latch in a following write, so by
    // the time a wait is knowable its phase has already changed. A rule that waited for the
    // phase to move would miss every wait there is; telling the waits apart, and acting on
    // each of them once, is the caller's job.
    expect(flashForPhaseChange("attention", "attention", 1_000)).toBe("ask");
  });

  it("does not flash for a state that has not changed", () => {
    expect(flashForPhaseChange("working", "working", undefined)).toBe(null);
    expect(flashForPhaseChange("finished", "finished", undefined)).toBe(null);
    expect(flashForPhaseChange(undefined, undefined, undefined)).toBe(null);
  });

  it("does not flag a wait the user is looking at", () => {
    // The tab on screen is the tab being read; only a wait elsewhere is worth a flash.
    expect(flashForPhaseChange("working", "attention", undefined)).toBe(null);
  });
});

describe("useAgentActivityStore", () => {
  beforeEach(() =>
    useAgentActivityStore.setState({
      phases: {},
      agents: {},
      leafPty: {},
      unseen: {},
      unseenDone: {},
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
    expect(Object.keys(first)).toHaveLength(1);
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

  it("latches a wait on the active tab while the window is not in front", () => {
    // "The user is looking at this session" is the set of leaves the window is showing, and a
    // window hidden in the tray (or behind another one) shows nothing at all - that empty set
    // is what the app writes while it is not in front. A wait that starts then is a wait the
    // user has not seen, whichever tab it happens to be on: the tab-level reading of "seen"
    // was what made a question asked behind a tray-hidden window go unflagged.
    const { setLeafPty, setForegroundLeaves } = useAgentActivityStore.getState();
    setLeafPty(7, 70);
    setForegroundLeaves([]);
    applySignal({ id: 70, kind: "attention" });
    expect(useAgentActivityStore.getState().unseen[70]).toBeTypeOf("number");
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
