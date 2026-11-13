/**
 * What each session's own shell last said about a command being in flight.
 *
 * The shell integration this app installs (`src-tauri/src/modules/pty/scripts/bashrc.bash` and its
 * siblings) prints the OSC 133 prompt markers, and the terminal's parser turns them into
 * `prompt-start`, `end-of-input` and `end-of-command` events. Those are the shell testifying about
 * itself: a command was started (`133;C`, which bash puts in `PS0`) and has not finished, or a
 * prompt has been drawn since (`133;A`/`133;D`), which means nothing is running in the foreground.
 *
 * It exists because the screen cannot say this and neither can the system. A screen outlives its
 * process: quitting an agent leaves its last frame in place and the shell's prompt is drawn under
 * it, so a question stays readable for as long as the tab lives. The system's answer is worse than
 * absent here - measured on this machine (2026-11-13): a command started in a Git bash shell is
 * recorded against a fork helper process that exits at once, so the Windows parent table says the
 * shell has no children while `sleep 60` is running (`Get-CimInstance Win32_Process`: `sleep.exe`
 * 26292, parent 21748, and 21748 is gone). An answer built on that would have reported every busy
 * session as stopped.
 *
 * `null` is not `false`: a shell with no integration (a distribution's shell reached through
 * `wsl.exe`, a `sh` that sources nothing) never reports anything, and callers must treat that as
 * "no opinion" rather than as rest.
 */
const commandRunning = new Map<number, boolean>();

/** Record what the shell said, as the terminal's own event router heard it. */
export function noteLeafCommandState(leafId: number, running: boolean): void {
  commandRunning.set(leafId, running);
}

/**
 * Whether this leaf's shell says a command is in flight, or `null` when its shell has never said
 * anything about it.
 */
export function leafCommandRunning(leafId: number): boolean | null {
  return commandRunning.get(leafId) ?? null;
}

/** Forget a leaf: its session is gone, and a reused leaf id starts from nothing. */
export function forgetLeafCommandState(leafId: number): void {
  commandRunning.delete(leafId);
}
