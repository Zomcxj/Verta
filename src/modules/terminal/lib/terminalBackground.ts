/**
 * The one thing a full-screen TUI can be told about the terminal's paper.
 *
 * A tool that paints its own colours - Claude Code, opencode - reads its palette from its own theme and
 * writes 24-bit escapes, so nothing the terminal's own palette says can reach it. What it can read is
 * `COLORFGBG`, xterm's old "what colour is the background" variable: `foreground;background` as colour
 * indexes. Both tools were read in their own binaries on this machine and both take the **last** field
 * (see `terminalBackground.test.ts` for the two rules), so the last field carries the answer.
 *
 * 15 (bright white) for a light window and 0 (black) for a dark one: those two are on the light and the
 * dark side of both tools' thresholds, which is all this has to promise.
 */
export function colorFgBg(mode: "light" | "dark"): string {
  return mode === "light" ? "0;15" : "15;0";
}
