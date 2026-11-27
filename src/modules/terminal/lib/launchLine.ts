/**
 * Is the launch command still on the screen?
 *
 * Opening a session writes a command into the terminal, the shell echoes it, and the
 * cover that hides that moment has to know when the line stops being displayed. A byte
 * count cannot answer this: pi's banner is several hundred bytes painted on the normal
 * screen, so a byte threshold is met while the command line is still sitting above the
 * banner. Reading the screen can answer it, and this is the reading.
 *
 * Whitespace is squeezed out of both sides before comparing, because the terminal wraps
 * a long command at its own width: what survives a wrap is the characters of the command
 * and their order, not the spaces. That also means a match is a claim about *characters
 * being on the screen somewhere* rather than about one particular row, which is the
 * conservative direction for the caller: a false match keeps the cover up, and a cover
 * that outlives its command is invisible, while one that leaves early is exactly the
 * flicker this exists to prevent.
 *
 * The comparison is case sensitive, and that is load-bearing for a new session: its
 * command is just the tool's name (`pi`), and the agent's own interface is full of the
 * capitalised version of that word.
 */

/** The text with every run of whitespace removed. */
export function squeezeWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

/** Whether the command we wrote is still somewhere on this screen. */
export function screenShowsLaunchLine(screen: string, command: string): boolean {
  const wanted = squeezeWhitespace(command);
  if (wanted.length === 0) return false;
  return squeezeWhitespace(screen).includes(wanted);
}

/**
 * Whether the launch command is being displayed, given which buffer is on screen.
 *
 * The alternate screen is a separate buffer, so the shell's echo of the command stops being
 * displayed the moment a full-screen program switches to it - that is what
 * `leafUsesAlternateScreen` answers without reading any text. The text still has to be read, but
 * only as a question about the buffer that is *shown*: a resumed session can put the very command
 * that launched it inside its own conversation (the reader had been asking about it), and reading
 * that mention as the echo kept the cover up over a running agent for the whole hard cap.
 */
export function launchLineDisplayed(
  screen: string | null,
  command: string,
  alt: boolean,
): boolean {
  if (alt || screen === null) return false;
  return screenShowsLaunchLine(screen, command);
}
