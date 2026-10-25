import { describe, expect, it } from "vitest";
import type { AgentSignal } from "./agentActivity";
import { AGENT_GONE_MS, emptyJudgeEntry, judgeTail } from "./agentJudge";

/** Real captures from this machine (see `agentRules.test.ts` for the source). */
const OPENCODE_WORKING =
  "Writing the patch\n⠹ Thinking\nctrl+p commands   · Tokens 12.4k";
const OPENCODE_IDLE = "Where to next?\nctrl+p commands   · Tokens 12.4k";
const OPENCODE_BLOCKED =
  "△ Permission required\n  Allow once\n  Allow always\n  Deny\nctrl+p commands";
const SHELL_PROMPT = "special@LAPTOP MINGW64 /f/VibeCoding/work (main)\n$ ";

const kinds = (signals: readonly AgentSignal[]) =>
  signals.map((signal) => signal.kind);

/** The first state of a leaf, at a given instant. */
function first(tail: string, nowMs = 1_000) {
  const outcome = judgeTail(emptyJudgeEntry(7), tail, nowMs);
  if (outcome.kind !== "report") throw new Error(`expected a report, got ${outcome.kind}`);
  return outcome;
}

describe("judgeTail", () => {
  it("says nothing at all about a plain shell prompt", () => {
    const outcome = judgeTail(emptyJudgeEntry(7), SHELL_PROMPT, 1_000);
    expect(outcome.kind).toBe("quiet");
    if (outcome.kind === "quiet") expect(outcome.entry.tool).toBeNull();
  });

  it("announces the agent and its first state together", () => {
    const outcome = first(OPENCODE_WORKING);
    expect(kinds(outcome.signals)).toEqual(["started", "working"]);
    expect(outcome.signals[0]).toEqual({
      id: 7,
      kind: "started",
      agent: "opencode",
    });
    expect(outcome.entry).toMatchObject({ id: 7, tool: "opencode", state: "working" });
  });

  it("does not repeat an announcement or a state that has not changed", () => {
    const working = first(OPENCODE_WORKING);
    expect(judgeTail(working.entry, OPENCODE_WORKING, 2_000).kind).toBe("quiet");
  });

  it("reports a question as attention", () => {
    const working = first(OPENCODE_WORKING);
    const blocked = judgeTail(working.entry, OPENCODE_BLOCKED, 2_000);
    expect(blocked.kind).toBe("report");
    if (blocked.kind !== "report") return;
    expect(kinds(blocked.signals)).toEqual(["attention"]);
    expect(blocked.entry.state).toBe("blocked");
  });

  it("marks a finished turn, which the store shows as done before idle", () => {
    const working = first(OPENCODE_WORKING);
    const idle = judgeTail(working.entry, OPENCODE_IDLE, 2_000);
    expect(idle.kind).toBe("report");
    if (idle.kind !== "report") return;
    expect(kinds(idle.signals)).toEqual(["finished"]);
  });

  it("reports idle directly when the agent was never busy", () => {
    // The first screen after the agent appears is already its idle prompt, so the
    // change is "unknown to idle", not "a turn finished".
    expect(kinds(first(OPENCODE_IDLE).signals)).toEqual(["started", "idle"]);
  });

  it("starts fresh when the leaf has been reused for another pty", () => {
    // Same leaf, new pty: the entry is keyed by pty, so the caller hands in a fresh
    // one and the agent is announced again.
    expect(kinds(first(OPENCODE_WORKING).signals)).toEqual(["started", "working"]);
  });
});

describe("an agent that leaves the screen", () => {
  const working = { ...first(OPENCODE_WORKING).entry };

  it("does not call the agent gone on the first screen without it", () => {
    const outcome = judgeTail(working, SHELL_PROMPT, 5_000);
    expect(outcome.kind).toBe("quiet");
    if (outcome.kind === "quiet") {
      expect(outcome.entry.tool).toBe("opencode");
      expect(outcome.entry.state).toBe("working");
      expect(outcome.entry.lostSince).toBe(5_000);
    }
  });

  it("keeps the last state through a redraw inside the grace period", () => {
    const firstMiss = judgeTail(working, SHELL_PROMPT, 5_000);
    if (firstMiss.kind !== "quiet") throw new Error("quiet");
    const secondMiss = judgeTail(firstMiss.entry, "", 5_000 + AGENT_GONE_MS - 1);
    expect(secondMiss.kind).toBe("quiet");
    if (secondMiss.kind === "quiet") {
      // The clock is not restarted by every miss: one grace period, not one per tick.
      expect(secondMiss.entry.lostSince).toBe(5_000);
    }
  });

  it("reports finished once the grace period has passed", () => {
    const firstMiss = judgeTail(working, SHELL_PROMPT, 5_000);
    if (firstMiss.kind !== "quiet") throw new Error("quiet");
    const gone = judgeTail(firstMiss.entry, SHELL_PROMPT, 5_000 + AGENT_GONE_MS);
    expect(gone.kind).toBe("report");
    if (gone.kind !== "report") return;
    expect(kinds(gone.signals)).toEqual(["finished"]);
    expect(gone.entry).toEqual({ id: 7, tool: null, state: "idle", lostSince: null });
  });

  it("clears the grace period as soon as the agent is back", () => {
    const firstMiss = judgeTail(working, SHELL_PROMPT, 5_000);
    if (firstMiss.kind !== "quiet") throw new Error("quiet");
    const back = judgeTail(firstMiss.entry, OPENCODE_BLOCKED, 5_500);
    expect(back.kind).toBe("report");
    if (back.kind !== "report") return;
    expect(back.entry.lostSince).toBeNull();
    expect(kinds(back.signals)).toEqual(["attention"]);
    // And the agent is not called gone a second time for a screen that has already
    // been reported as finished.
    const gone = judgeTail(
      { id: 7, tool: "opencode", state: "idle", lostSince: 6_000 },
      SHELL_PROMPT,
      6_000 + AGENT_GONE_MS,
    );
    expect(gone.kind).toBe("quiet");
    if (gone.kind === "quiet") expect(gone.entry.tool).toBeNull();
  });

  it("never asks about a screen that was never an agent", () => {
    // A foreign full-screen program is not an agent leaving; it is nothing at all.
    const outcome = judgeTail(emptyJudgeEntry(7), "man verta\n", 1_000);
    expect(outcome.kind).toBe("quiet");
  });
});