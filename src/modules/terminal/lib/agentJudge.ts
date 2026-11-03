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

/**
 * How long a screen has to keep saying "idle" - after it said something else - before that is
 * believed.
 *
 * The evidence that a session is working is a line the agent paints, and agents do not paint every
 * line on every frame: measured on this machine with opencode, the spinner glyph is missing from
 * the read often enough that a single tick can miss it while the turn is still running, and each
 * miss was reported as a turn that had finished - a green dot and a notification for work that had
 * not stopped, six of them in three minutes. Three reads at the store's cadence, and a read that
 * says anything else in between starts the count again.
 */
export const IDLE_SETTLE_MS = 1500;

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
  /**
   * When this screen first said "idle" after saying something else (ms), or `null` while it is
   * not saying that. A state that has to be settled before it is reported - see `IDLE_SETTLE_MS`.
   */
  readonly idleSince: number | null;
};

export const emptyJudgeEntry = (id: number): JudgeEntry => ({
  id,
  tool: null,
  state: "unknown",
  lostSince: null,
  idleSince: null,
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
 *
 * A question is not a turn, so an idle screen that follows one is rest rather than
 * an ending: the card left because the user answered it, because they dismissed it,
 * or because the agent took the screen back. Measured on the installed build, one
 * turn put two "a turn finished" notices into Windows' store that way - one for the
 * card leaving and one for the turn, eleven seconds apart - and the same command run
 * against a terminal with no card on it put exactly one.
 */
function signalKindFor(
  state: AgentState,
  previous: AgentState,
): AgentSignal["kind"] {
  if (state === "working") return "working";
  if (state === "blocked") return "attention";
  // Background work continuing is its own kind rather than "working" or "idle": the store draws it
  // as neither, and a turn that ended into background work must not latch as a finished turn the
  // user has not looked at. See `AgentPhase` for what the two are drawn as.
  if (state === "trailing") return "trailing";
  if (previous === "working") return "finished";
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
    entry = {
      id: entry.id,
      tool: family.tool,
      state: "unknown",
      lostSince: null,
      idleSince: null,
    };
    signals.push({ id: entry.id, kind: "started", agent: family.tool });
  }

  const detection = evaluate(tail, family.rules);
  if (detectionApplies(detection)) {
    if (detection.state === entry.state) {
      // The screen still says what it said: a settled state stays settled.
      entry = { ...entry, idleSince: null };
    } else if (
      detection.state === "idle" &&
      (entry.state === "working" || entry.state === "blocked")
    ) {
      // Work stopping is only believed once the screen has gone on saying so: see
      // `IDLE_SETTLE_MS`. Until then the state stands, and the leaf is held at it.
      const idleSince = entry.idleSince ?? nowMs;
      if (nowMs - idleSince < IDLE_SETTLE_MS) {
        entry = { ...entry, idleSince };
      } else {
        signals.push({
          id: entry.id,
          kind: signalKindFor(detection.state, entry.state),
        });
        entry = { ...entry, state: detection.state, idleSince: null };
      }
    } else {
      signals.push({
        id: entry.id,
        kind: signalKindFor(detection.state, entry.state),
      });
      entry = { ...entry, state: detection.state, idleSince: null };
    }
  } else if (
    detection.state === "unknown" &&
    (entry.state === "working" || entry.state === "trailing")
  ) {
    // The family is on screen but no rule can read this screen: not the footer at rest, not the
    // interrupt hint, not a spinner, not a tally. That is *no* evidence of work, and holding the
    // last claim for as long as the screen says nothing made a dot that never went out - measured
    // on this machine (2026-11-03) with a session that had been closed since the day before: its
    // tab opened orange, `phases[42] = working`, on a screen whose whole bottom was
    // `~/Desktop    251.1K (50%)  ctrl+p commands`.
    //
    // The wait is the same one `idle` gets, for the same reason: a working screen is not always
    // classifiable on every frame (the spinner is painted on some and not others, the hint is
    // drawn elided as `esc...rupt`), so a single unreadable read is a frame, not an ending.
    //
    // Reported as `idle`, not through `signalKindFor`: an unreadable screen cannot say a turn
    // ended, and inventing that would put "a turn finished" in front of the user for work that
    // may not have stopped. Nothing is being done on that session either way.
    const idleSince = entry.idleSince ?? nowMs;
    if (nowMs - idleSince < IDLE_SETTLE_MS) {
      entry = { ...entry, idleSince };
    } else {
      signals.push({ id: entry.id, kind: "idle" });
      entry = { ...entry, state: "idle", idleSince: null };
    }
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
    idleSince: null,
  };
  // The agent left the screen, and the store has to be told or the tab goes on describing an agent
  // that is not there. It used to be told only when the screen had been showing a turn: an agent
  // that settled to `idle` first (which is what a prompt does) then went away left its name behind,
  // and a tab whose pane is a bare `$` prompt was drawn green for the rest of the window's life -
  // measured on this machine, `phases[65] = idle` and `agents[65] = opencode` on a pane whose whole
  // screen was `special@LAPTOP MINGW64 ~/Desktop` and `$`.
  //
  // `exited` clears the phase, the name and both latches, which is exactly what is true here: there
  // is no agent on this session. `idle` was the signal for "the agent is still there, at its prompt"
  // and this is the opposite of that.
  if (previous.state === "idle") {
    // Already reported as finished; the store's bookkeeping is all that is left to clear.
    return { kind: "report", entry, signals: [{ id: previous.id, kind: "exited" }] };
  }
  if (previous.state === "blocked") {
    // What left the screen was a question, and a question is not a turn: reported as rest, so
    // nothing is latched and no notification follows. See `signalKindFor` for the measurement.
    return {
      kind: "report",
      entry,
      signals: [
        { id: previous.id, kind: "idle" },
        { id: previous.id, kind: "exited" },
      ],
    };
  }
  return {
    kind: "report",
    entry,
    signals: [
      { id: previous.id, kind: "finished" },
      { id: previous.id, kind: "exited" },
    ],
  };
}