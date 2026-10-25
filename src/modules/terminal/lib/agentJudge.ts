/**
 * Turns one read of a terminal's screen into agent signals.
 *
 * The judge in `agentState.ts` answers "what does this text show" and the rules in
 * `agentRules.ts` answer "whose screen is this"; this module is what steps between
 * them and the activity store: it holds what was last said about a leaf, decides
 * what (if anything) is worth saying now, and does it from the screen alone.
 *
 * "From the screen alone" is the whole point, and it is also why the clock is a
 * parameter: the one thing a screen cannot say by itself is when a screen *stopped*
 * showing an agent. Quitting an agent puts the shell's prompt back, with no trace
 * of the agent in it, so the only evidence is that the agent's chrome has not been
 * there for a while. A grace period is what that "while" is, and it is why a rule
 * table that reads a live screen is enough without asking anyone.
 *
 * The alternative the plan first reached for, asking the kernel whether the shell
 * still has a child, did not work as written: on Windows the pid the pty spawns is
 * Git's `bin\bash.exe`, a stub that keeps the real `usr\bin\bash.exe` as its only child
 * for as long as the tab lives, so the query answered "yes, something is running" at an
 * idle prompt (measured, see the probe this module was verified with; the pty module now
 * walks past that stub). The screen is the better instrument, and it is free.
 */

import type { AgentSignal } from "@/modules/terminal/lib/agentActivity";
import {
  type AgentState,
  detectionApplies,
  evaluate,
} from "@/modules/terminal/lib/agentState";
import { identifyAgent } from "@/modules/terminal/lib/agentRules";

/**
 * How long a screen may stop identifying an agent, after it had been identifying
 * one, before the agent is called gone.
 *
 * A live agent's chrome is on screen continuously: an agent prints its footer or
 * status line at the bottom of a full-screen interface and repaints it as it works.
 * So a gap this long is not a redraw, it is an agent that left (or a program that
 * took the screen, which nothing can tell apart from the agent being gone, and
 * `idle` is the right answer either way: nothing is waiting on that tab).
 *
 * Four ticks at the store's cadence, chosen to be longer than any repaint.
 */
export const AGENT_GONE_MS = 2000;

/** What was last reported about one leaf. */
export type JudgeEntry = {
  /** The pty the leaf was showing when this entry was made. */
  readonly id: number;
  /** The agent on screen, or `null` when none is. */
  readonly tool: string | null;
  /** The last state reported for it. */
  readonly state: AgentState;
  /** When the screen stopped identifying an agent (ms), or `null` while it does. */
  readonly lostSince: number | null;
};

export const emptyJudgeEntry = (id: number): JudgeEntry => ({
  id,
  tool: null,
  state: "unknown",
  lostSince: null,
});

export type JudgeOutcome =
  /** Something changed; apply these signals (in order) and keep the entry. */
  | {
      readonly kind: "report";
      readonly entry: JudgeEntry;
      readonly signals: readonly AgentSignal[];
    }
  /** Nothing worth saying; keep the entry. */
  | { readonly kind: "quiet"; readonly entry: JudgeEntry };

/**
 * The signal a state change emits.
 *
 * `blocked` is the store's `attention` and `working` is `working`; `idle` becomes
 * the transient `finished` when the agent was busy a moment ago, which is what the
 * store turns into a short "done" mark before settling on idle.
 */
function signalKindFor(
  state: AgentState,
  previous: AgentState,
): AgentSignal["kind"] {
  if (state === "working") return "working";
  if (state === "blocked") return "attention";
  if (previous === "working" || previous === "blocked") return "finished";
  return "idle";
}

/**
 * Judge one screen read.
 *
 * `previous` is what was last reported for this pty, `tail` is the visible screen as
 * text and `nowMs` is the caller's clock. A leaf that has been reused for another
 * pty starts from `emptyJudgeEntry`, which is how the agent on it is announced
 * again.
 */
export function judgeTail(
  previous: JudgeEntry,
  tail: string,
  nowMs: number,
): JudgeOutcome {
  const family = identifyAgent(tail);
  if (family === null) return judgeWithoutAgent(previous, nowMs);

  const signals: AgentSignal[] = [];
  let entry: JudgeEntry = { ...previous, lostSince: null };
  if (entry.tool !== family.tool) {
    // The agent appeared. The store takes the name from this signal, which is what
    // the tab's brand icon is drawn from.
    entry = { id: entry.id, tool: family.tool, state: "unknown", lostSince: null };
    signals.push({ id: entry.id, kind: "started", agent: family.tool });
  }

  const detection = evaluate(tail, family.rules);
  if (detectionApplies(detection) && detection.state !== entry.state) {
    signals.push({
      id: entry.id,
      kind: signalKindFor(detection.state, entry.state),
    });
    entry = { ...entry, state: detection.state };
  }

  if (signals.length === 0) return { kind: "quiet", entry };
  return { kind: "report", entry, signals };
}

/** No agent on screen: either there never was one, or one has just left. */
function judgeWithoutAgent(previous: JudgeEntry, nowMs: number): JudgeOutcome {
  if (previous.tool === null) {
    // Nothing here was an agent and nothing has gone: say nothing.
    return { kind: "quiet", entry: previous };
  }
  const lostSince = previous.lostSince ?? nowMs;
  if (nowMs - lostSince < AGENT_GONE_MS) {
    // Within the grace period: a redraw, or a program taking the screen for a
    // moment. The last state stands.
    return {
      kind: "quiet",
      entry: { ...previous, lostSince },
    };
  }
  const entry: JudgeEntry = {
    id: previous.id,
    tool: null,
    state: "idle",
    lostSince: null,
  };
  if (previous.state === "idle") {
    // Already reported as finished; only the bookkeeping changes.
    return { kind: "quiet", entry };
  }
  return { kind: "report", entry, signals: [{ id: previous.id, kind: "finished" }] };
}