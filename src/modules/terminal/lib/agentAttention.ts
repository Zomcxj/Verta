/**
 * Whether an agent running in a tab wants the user.
 *
 * None of the agents announce "I am waiting for you": they paint a full-screen
 * TUI and then, when they need an answer, simply stop painting. Two things can
 * be observed from outside that TUI, and these are what the taskbar flash is
 * built on:
 *
 * - whether the shell still has a child process (the same kernel query the close
 *   guard uses), which turns false when the CLI exits;
 * - how many bytes the leaf has received in total, which stops moving exactly
 *   when the CLI stops repainting.
 *
 * So: the child went away after having been there — finished. The child is there
 * but nothing new was painted for a while — waiting for input. Both only count
 * once the CLI has painted something, which is why a freshly opened tab that has
 * not started yet stays quiet.
 */

/** How long a silent agent counts as waiting. Its spinner keeps repainting while
 *  it works, so silence is the one cheap signal that it is blocked on the user. */
export const AGENT_QUIET_MS = 4000;

export type AgentSample = {
  /** Cumulative bytes the leaf has received from its pty. */
  bytes: number;
  /** The shell has a child process, i.e. the CLI is running. */
  hasChild: boolean;
};

export type AgentWatch = AgentSample & {
  /** When the byte count last moved; 0 until a move has been seen. */
  quietSince: number;
  /** A wait was already reported for the current quiet stretch. */
  reported: boolean;
};

export const EMPTY_AGENT_WATCH: AgentWatch = {
  bytes: 0,
  hasChild: false,
  quietSince: 0,
  reported: false,
};

/** What one sample says should happen; `null` for "nothing to report". */
export type AgentAttention = "ask" | "done" | null;

export function advanceAgentWatch(
  watch: AgentWatch,
  sample: AgentSample,
  nowMs: number,
  quietMs: number = AGENT_QUIET_MS,
): { watch: AgentWatch; attention: AgentAttention } {
  const painted = sample.bytes > watch.bytes;
  const exited = watch.hasChild && !sample.hasChild;
  let quietSince = watch.quietSince;
  let reported = watch.reported;
  let attention: AgentAttention = null;

  if (painted) {
    // Output means it is doing something again; the next silence is a new wait.
    quietSince = nowMs;
    reported = false;
  } else if (
    !exited &&
    sample.hasChild &&
    quietSince > 0 &&
    !reported &&
    nowMs - quietSince >= quietMs
  ) {
    reported = true;
    attention = "ask";
  }
  // An exit outranks silence: the run is over, whatever the last paint was.
  if (exited) attention = "done";

  return {
    watch: {
      bytes: sample.bytes,
      hasChild: sample.hasChild,
      quietSince,
      reported,
    },
    attention,
  };
}
