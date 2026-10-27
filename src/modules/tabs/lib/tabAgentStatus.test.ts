import { shallow } from "zustand/shallow";
import { beforeEach, describe, expect, it } from "vitest";
import { useAgentActivityStore } from "@/modules/terminal/lib/agentActivity";
import {
  NO_AGENT_STATUS,
  ptyIdsForLeaves,
  selectTabAgentStatus,
  selectTabAgentStatusFromLeaves,
  selectTabAgentUnseen,
} from "./tabAgentStatus";

const select = (ptyIds: readonly number[]) =>
  selectTabAgentStatus(useAgentActivityStore.getState(), ptyIds);

const selectFromLeaves = (leafIds: readonly number[]) =>
  selectTabAgentStatusFromLeaves(useAgentActivityStore.getState(), leafIds);

beforeEach(() => {
  useAgentActivityStore.setState({
    phases: {},
    agents: {},
    leafPty: {},
    unseen: {},
    unseenDone: {},
    foregroundLeaves: new Set(),
  });
});

describe("selectTabAgentStatus", () => {
  it("returns the shared empty status without scanning for tabs with no ptys", () => {
    expect(select([])).toBe(NO_AGENT_STATUS);
  });

  it("reflects only the tab's own ptys", () => {
    const store = useAgentActivityStore.getState();
    store.setPhase(2, "working");
    store.setAgent(2, "claude");
    expect(select([1])).toEqual({ state: null, agent: null });
    expect(select([1, 2])).toEqual({ state: "working", agent: "claude" });
  });

  it("stays shallow-equal when an unrelated pty changes, so the tab skips re-rendering", () => {
    const store = useAgentActivityStore.getState();
    store.setPhase(1, "working");
    store.setAgent(1, "codex");
    const before = select([1]);

    store.setPhase(2, "attention");
    store.setAgent(2, "claude");
    store.setPhase(3, "finished");
    store.clear(3);

    expect(shallow(before, select([1]))).toBe(true);
  });

  it("changes when the tab's own pty changes phase", () => {
    const store = useAgentActivityStore.getState();
    store.setPhase(1, "working");
    const before = select([1]);
    store.setPhase(1, "attention");
    expect(shallow(before, select([1]))).toBe(false);
  });
});

describe("selectTabAgentStatusFromLeaves", () => {
  it("returns the shared empty status without a leaf map to look at", () => {
    expect(selectFromLeaves([])).toBe(NO_AGENT_STATUS);
  });

  it("follows a leaf's pty as the store learns it", () => {
    // Before the judge has reported, the leaf has no pty and no dot can be drawn.
    expect(selectFromLeaves([11])).toEqual({ state: null, agent: null });

    const store = useAgentActivityStore.getState();
    store.setLeafPty(11, 7);
    store.setAgent(7, "opencode");
    store.setPhase(7, "attention");
    expect(selectFromLeaves([11])).toEqual({
      state: "attention",
      agent: null,
    });

    // A leaf that was reused for another pty reads the new one, not the old state.
    expect(useAgentActivityStore.getState().leafPty[11]).toBe(7);
    store.setLeafPty(11, 8);
    expect(selectFromLeaves([11])).toEqual({ state: null, agent: null });
  });

  it("keeps a tab with no live pty out of the way of a tab that has one", () => {
    const store = useAgentActivityStore.getState();
    store.setLeafPty(1, 7);
    store.setLeafPty(2, 8);
    store.setPhase(8, "working");
    expect(selectFromLeaves([1])).toEqual({ state: null, agent: null });
    expect(selectFromLeaves([2]).state).toBe("working");
    expect(selectFromLeaves([1, 2]).state).toBe("working");
  });

  it("maps leaves to ptys without inventing one for a leaf the store does not know", () => {
    const store = useAgentActivityStore.getState();
    store.setLeafPty(1, 7);
    const state = useAgentActivityStore.getState();
    expect(ptyIdsForLeaves(state, [1, 2, 3])).toEqual([7]);
  });
});

describe("selectTabAgentUnseen", () => {
  const unseenOf = (leafIds: readonly number[]) =>
    selectTabAgentUnseen(useAgentActivityStore.getState(), leafIds);

  it("is false for a tab with nothing waiting on it", () => {
    expect(unseenOf([])).toBe(false);
    const store = useAgentActivityStore.getState();
    store.setLeafPty(1, 7);
    expect(unseenOf([1])).toBe(false);
  });

  it("is true while the session it holds is waiting unseen, and false once seen", () => {
    const store = useAgentActivityStore.getState();
    store.setLeafPty(1, 7);
    store.setLeafPty(2, 8);
    store.setPhase(7, "attention");
    store.markAttentionUnseen(7, 5_000);
    expect(unseenOf([1])).toBe(true);
    // Looking at the session clears the latch, and the phase stays what it is.
    store.markAttentionSeen([7]);
    expect(unseenOf([1])).toBe(false);
    expect(useAgentActivityStore.getState().phases[7]).toBe("attention");
  });

  it("does not leak one tab's latch onto another", () => {
    const store = useAgentActivityStore.getState();
    store.setLeafPty(1, 7);
    store.setLeafPty(2, 8);
    store.markAttentionUnseen(7, 5_000);
    expect(unseenOf([1])).toBe(true);
    expect(unseenOf([2])).toBe(false);
  });
});
