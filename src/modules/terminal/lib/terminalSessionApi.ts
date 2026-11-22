import type { BlockMode } from "@/modules/terminal/block/lib/modeMachine";
import {
  clearGhosttySession,
  disposeGhosttySession,
  focusGhosttySession,
  ghosttyFocusedLeaf,
  ghosttyFrameCount,
  ghosttyLeafHasForegroundProcess,
  ghosttyLeafOutputBytes,
  ghosttyLeafScreenTail,
  ghosttyLeafUsesAlternateScreen,
  ghosttyLeafIdForPty,
  ghosttyCwdForLeaf,
  ghosttyPtyIdForLeaf,
  ghosttySelectionForLeaf,
  hasGhosttySession,
  interruptGhosttySession,
  pasteIntoGhosttySession,
  subscribeGhosttyFrame,
  submitToGhosttySession,
  whenGhosttySessionReady,
  writeToGhosttySession,
} from "@/modules/terminal/ghostty/useGhosttyTerminalSession";
import {
  disposeGhosttyBlocks,
  ensureGhosttyBlocks,
  ghosttyBlocks,
} from "@/modules/terminal/ghostty/ghosttyBlockSessions";
export type { WatermarkState } from "@/modules/terminal/ghostty/ghosttyBlockSessions";
import { forgetLeafPresentation } from "@/modules/terminal/lib/ptyPresentation";
import { leafCommandRunning as shellCommandRunning } from "@/modules/terminal/ghostty/shellCommandState";
import type { WatermarkState } from "@/modules/terminal/ghostty/ghosttyBlockSessions";

export async function whenSessionReady(
  leafId: number,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    if (hasGhosttySession(leafId)) {
      await withTimeout(whenGhosttySessionReady(leafId), remaining);
      return;
    }
    await delay(Math.min(10, remaining));
  }
}

export function writeToSession(leafId: number, data: string): boolean {
  return writeToGhosttySession(leafId, data);
}

export function submitToLeaf(leafId: number, text: string): void {
  submitToGhosttySession(leafId, text);
}

export function interruptLeaf(leafId: number): void {
  interruptGhosttySession(leafId);
}

export function pasteIntoSession(leafId: number, text: string): boolean {
  return pasteIntoGhosttySession(leafId, text);
}

export function leafCwd(leafId: number): string | null {
  return ghosttyCwdForLeaf(leafId);
}

export function navigateFocusedBlocks(direction: -1 | 1): boolean {
  const leaf = ghosttyFocusedLeaf();
  return (
    leaf !== null &&
    (ghosttyBlocks(leaf)?.controller?.navigate(direction) ?? false)
  );
}

export function clearLeafBlockSelection(leafId: number): boolean {
  return ghosttyBlocks(leafId)?.controller?.clearSelection() ?? false;
}

export function leafGridSelection(leafId: number): string | null {
  return ghosttySelectionForLeaf(leafId);
}

export function getLeafBlockMode(leafId: number): BlockMode {
  return ghosttyBlocks(leafId)?.getMode() ?? "plain";
}

export function subscribeLeafBlockMode(
  leafId: number,
  callback: () => void,
): () => void {
  return ensureGhosttyBlocks(leafId).subscribeMode(callback);
}

export function setLeafInputFocus(
  leafId: number,
  callback: (() => void) | null,
): void {
  const state = callback ? ensureGhosttyBlocks(leafId) : ghosttyBlocks(leafId);
  if (state) state.focus = callback;
}

export function setLeafInputPaste(
  leafId: number,
  paste: ((text: string) => void) | null,
): void {
  const state = paste ? ensureGhosttyBlocks(leafId) : ghosttyBlocks(leafId);
  if (state) state.paste = paste;
}

export function setLeafInputKeyDown(
  leafId: number,
  handler: ((event: KeyboardEvent) => boolean) | null,
): void {
  const state = handler ? ensureGhosttyBlocks(leafId) : ghosttyBlocks(leafId);
  if (state) state.keyDown = handler;
}

export function focusLeafInput(leafId: number): void {
  const state = ghosttyBlocks(leafId);
  if (state?.getMode() === "prompt" && state.focus) state.focus();
  else focusGhosttySession(leafId);
}

export function getLeafDraft(leafId: number): string {
  return ghosttyBlocks(leafId)?.draft ?? "";
}

export function setLeafDraft(leafId: number, text: string): void {
  const state = ghosttyBlocks(leafId);
  if (state) state.draft = text;
}

export function setLeafInputActivity(leafId: number, active: boolean): void {
  const blocks = ghosttyBlocks(leafId);
  if (!blocks || blocks.inputActive === active) return;
  blocks.inputActive = active;
  blocks.changed();
}

export function blockWatermarkState(leafId: number): WatermarkState {
  return ghosttyBlocks(leafId)?.watermark() ?? "hidden";
}

export function clearFocusedTerminal(): boolean {
  const ghosttyLeaf = ghosttyFocusedLeaf();
  if (ghosttyLeaf !== null) return clearGhosttySession(ghosttyLeaf);
  return false;
}

export function leafIdForPty(ptyId: number): number | null {
  return ghosttyLeafIdForPty(ptyId);
}

export function ptyIdForLeaf(leafId: number): number | null {
  return ghosttyPtyIdForLeaf(leafId);
}

/**
 * Whether this leaf's shell says a command is in flight, or `null` when it has never said.
 *
 * The shell's own statement, read from its OSC 133 markers: see `ghostty/shellCommandState.ts` for
 * why neither the screen nor the system's process table can answer this.
 */
export function leafCommandRunning(leafId: number): boolean | null {
  return shellCommandRunning(leafId);
}

export async function leafHasForegroundProcess(
  leafId: number,
): Promise<boolean> {
  return ghosttyLeafHasForegroundProcess(leafId);
}

/**
 * Cumulative bytes this leaf has received from its pty.
 *
 * The caller takes a baseline before writing a command, then uses the difference to
 * judge how much was painted on screen.
 */
export function leafOutputBytes(leafId: number): number {
  return ghosttyLeafOutputBytes(leafId);
}

/**
 * How many frames this leaf has presented, ever.
 *
 * Read before a write and handed to `whenLeafPaints`: a count that has moved means the write is
 * already on screen, so there is no reason to wait for a frame that a finished screen will never
 * produce.
 */
export function leafFrameCount(leafId: number): number {
  return ghosttyFrameCount(leafId);
}

/**
 * The visible screen of a leaf as plain text, or `null` when the leaf has no live
 * terminal. The agent judge reads this to decide what the agent is doing.
 */
export function leafScreenTail(leafId: number): string | null {
  return ghosttyLeafScreenTail(leafId);
}

/**
 * Whether a full-screen program has taken this leaf's screen over (see the
 * ghostty accessor). The opening cover waits for this: the alternate screen is a
 * separate buffer, so the command that was just typed into the shell stops being
 * displayed the moment the agent switches to it, without reading any text.
 */
export function leafUsesAlternateScreen(leafId: number): boolean {
  return ghosttyLeafUsesAlternateScreen(leafId);
}

/**
 * Resolve once this leaf has presented a frame newer than `sinceFrame`, or after `timeoutMs`.
 *
 * A presented frame is the renderer's own report that what the pty wrote is on screen.
 * The two do not move together: bytes arrive, and the frame follows on the renderer's
 * cadence, so a caller that lifts a cover on the byte count alone can lift onto a pane
 * that has not been painted since. Waiting on the renderer keeps the two in step for any
 * agent, since it is the renderer that reports this and not the agent's output.
 *
 * `sinceFrame` is the frame count the caller saw when it wrote. Passing it matters: the
 * renderer only draws surfaces that are dirty, so a screen that is already finished produces no
 * further frame and a wait for "the next one" can only end on the timeout. Measured on an idle
 * session, the next frame arrived 441-605 ms later, and that is the pause reported as "动画最后
 * 卡一下". A count that has already moved past `sinceFrame` means the write is on screen and
 * there is nothing to wait for.
 *
 * The timeout is the caller's protection, not a schedule: it resolves either way.
 */
export function whenLeafPaints(
  leafId: number,
  timeoutMs = 1_500,
  sinceFrame?: number,
): Promise<void> {
  if (sinceFrame !== undefined && ghosttyFrameCount(leafId) > sinceFrame) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      resolve();
    };
    const unsubscribe = subscribeGhosttyFrame(leafId, finish);
    const timer = setTimeout(finish, timeoutMs);
  });
}

export function disposeSession(leafId: number): void {
  disposeGhosttySession(leafId);
  disposeGhosttyBlocks(leafId);
  forgetLeafPresentation(leafId);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
