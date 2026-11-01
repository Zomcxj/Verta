/**
 * When the cover that hides a launch command may lift.
 *
 * The cover exists to hide one thing: the command line typed on the user's behalf. Everything here
 * is therefore a question about that line, and the rules are ordered so that a rule which cannot
 * see it never decides.
 *
 * The history matters, because each of these was measured lifting early on this machine:
 *
 * - `bytes-fallback` used to fire on a byte count alone, so pi's banner (several KB, drawn on the
 *   normal screen above a still-visible command) satisfied it;
 * - `silence` fired once the output stopped, which an agent loading its extensions does long before
 *   it takes the screen over;
 * - `timeout` fired on the clock, which says nothing about the screen at all;
 * - and all of them read the screen once, before the renderer had painted, so the frame that
 *   actually appeared could be a cleared buffer - blank, so "the command is not on screen" was
 *   true of a screen that showed nothing yet.
 *
 * The last one is why every rule's answer is confirmed after the paint rather than trusted from the
 * tick that decided: see `paintsWithoutLaunchLine` in `App.tsx`.
 */

/** The four numbers a tick reads. Kept together so a decision cannot mix two ticks. */
export type CoverTick = {
  /** Milliseconds since the wait began. */
  elapsed: number;
  /** Bytes the leaf has written since the wait began. */
  bytes: number;
  /** Milliseconds since the output last grew. */
  silentFor: number;
  /** Whether the launch command is on the screen right now. */
  showsLaunch: boolean;
  /** Whether the screen has anything on it at all. */
  hasOwnScreen: boolean;
  /** Whether the leaf has switched to the alternate screen. */
  alt: boolean;
  /** Whether the echo of the command has been seen at some point. */
  echoed: boolean;
};

export type CoverRule =
  | "own-screen"
  | "silence"
  | "bytes-fallback"
  | "timeout-no-command"
  | null;

export const AGENT_UI_INLINE_BYTES = 512;
export const AGENT_UI_SILENCE_MS = 500;
export const AGENT_UI_INLINE_FLOOR_MS = 1500;
/** The byte count that used to decide on its own; it now only decides when the screen is free. */
export const AGENT_UI_PAINT_BYTES = 900;
export const AGENT_UI_TIMEOUT_MS = 15000;

/**
 * Which rule would lift the cover for this tick, or `null` to keep waiting.
 *
 * Every branch that can return requires `!showsLaunch`. That is the invariant the whole file is
 * for: a rule fires only when the screen it read is free of the command. The caller still confirms
 * after the paint, because this reading is one frame behind the one the user will see.
 */
export function coverRuleFor(tick: CoverTick): CoverRule {
  const { elapsed, bytes, silentFor, showsLaunch } = tick;

  // The agent painted a screen of its own. `echoed` or `alt` is required so an ordinary shell
  // prompt - which is a screen of its own and arrives before the agent does - cannot end the wait.
  if (tick.hasOwnScreen && !showsLaunch && (tick.echoed || tick.alt)) {
    return "own-screen";
  }

  // An inline agent: a real frame, then quiet, which is what "waiting for input" looks like. The
  // floor keeps a branding flash from ending the wait.
  if (
    bytes >= AGENT_UI_INLINE_BYTES &&
    silentFor >= AGENT_UI_SILENCE_MS &&
    elapsed >= AGENT_UI_INLINE_FLOOR_MS &&
    !showsLaunch
  ) {
    return "silence";
  }

  // The byte count decides only when the screen cannot. `!echoed` is not enough on its own: a first
  // tick can land after a burst of output but before the shell has echoed, leaving it false while
  // the command is about to be drawn. Requiring a screen free of it closes that window.
  if (bytes >= AGENT_UI_PAINT_BYTES && !tick.echoed && !showsLaunch) {
    return "bytes-fallback";
  }

  // Past the budget the clock alone still may not decide; only a screen without the command can.
  //
  // `hasOwnScreen` is required here too, and for a reason that was measured: the timeout fires
  // exactly when the screen is ambiguous, and an agent that has just cleared its buffer shows
  // nothing - so `showsLaunch` is false about a screen that has not been painted yet. Lifting
  // there trades the command line for a blank pane, and then the agent paints over it, which is
  // the other half of the flicker this cover exists to prevent.
  if (elapsed >= AGENT_UI_TIMEOUT_MS && !showsLaunch && tick.hasOwnScreen) {
    return "timeout-no-command";
  }

  return null;
}
