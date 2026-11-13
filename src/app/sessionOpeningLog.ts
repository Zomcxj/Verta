import type { CoverRule } from "./coverRule";

/**
 * What each session-opening cover did, kept so a slow opening can be read instead of guessed at.
 *
 * The complaint this was written for: every so often the transition layer stays up a moment longer
 * than it should before the terminal appears ("会话加载过渡层末尾偶尔多停一会儿才进入"). The cover lifts
 * when the agent's own screen has been painted (`waitForAgentUi` in `App.tsx`), and its last resort
 * is a 45 s timer, so "a moment longer" could be anything from one missed frame to a session that
 * only ended at the cap. Two facts settle which:
 *
 * - how long the cover was actually up (shown -> lifted), and by which of the paths that lift it;
 * - what the leaf's screen showed at the instant it lifted, which is the thing every rule in
 *   `coverRule.ts` is a question about.
 *
 * Kept in a bounded ring rather than logged: this is read on a machine where the timing is wrong,
 * through `terminalDebugStats()` (see `terminalDiagnostics.ts`, which is also where a release build
 * turns it on), and it must cost nothing when nobody is looking.
 */

/** Which rule lifted the cover, or `"gave-up"` when the wait ran to its cap. */
export type SessionOpeningWait = {
  /** What the wait ended on, from `coverRuleFor`, or `"gave-up"` at the hard cap. */
  readonly rule: CoverRule | "gave-up";
  /** Ticks the wait ran. One tick is one read of the screen, 120 ms apart. */
  readonly ticks: number;
  /**
   * Ticks where a rule fired and the frame that arrived still showed the launch line, so the cover
   * stayed up. A run with several of these is one that hovered on the edge of lifting.
   */
  readonly heldTicks: number;
  /** Bytes the leaf had written since the write when the wait ended. */
  readonly bytes: number;
};

/** What ended the cover. Each of these is a different reason for the same visible pause. */
export type SessionOpeningLift =
  | "ui-painted"
  | "fallback-timer"
  | "tab-left"
  | "write-failed";

export type SessionOpeningRecord = {
  readonly seq: number;
  readonly leafId: number;
  readonly tool: string | null;
  /** How long the cover was up, in ms: shown -> lifted. */
  readonly coveredMs: number;
  readonly lift: SessionOpeningLift;
  readonly rule: CoverRule | "gave-up" | null;
  readonly ticks: number;
  readonly heldTicks: number;
  readonly bytes: number;
  /** The leaf's screen when the cover lifted, last 200 characters. */
  readonly screenTail: string | null;
};

/** How many openings are kept. A user reports one bad opening; the last few are enough to see it. */
const MAX_RECORDS = 50;

export const SCREEN_TAIL_CHARS = 200;

type Pending = { leafId: number; tool: string | null; shownAt: number };

const pending = new Map<number, Pending>();
const records: SessionOpeningRecord[] = [];
let sequence = 0;

/**
 * The cover went up.
 *
 * There is only ever one cover, so a start that arrives while another is pending replaces it: the
 * older one is dropped rather than recorded, because its timing was cut short by the newer start
 * and reading it as a slow opening would be wrong.
 */
export function noteSessionOpeningShown(
  token: number,
  leafId: number,
  tool: string | null,
  atMs: number = Date.now(),
): void {
  pending.clear();
  pending.set(token, { leafId, tool, shownAt: atMs });
}

/** The leaf the cover for `token` was opened on, or `null` when it is not the pending one. */
export function sessionOpeningLeaf(token: number): number | null {
  return pending.get(token)?.leafId ?? null;
}

/** The cover came down. A token that is no longer pending is ignored, so one start's lift cannot record on another's. */
export function noteSessionOpeningLifted(
  token: number,
  lift: SessionOpeningLift,
  wait: SessionOpeningWait | null,
  screenTail: string | null,
  atMs: number = Date.now(),
): void {
  const shown = pending.get(token);
  if (shown === undefined) return;
  pending.delete(token);
  records.push({
    seq: ++sequence,
    leafId: shown.leafId,
    tool: shown.tool,
    coveredMs: Math.max(0, atMs - shown.shownAt),
    lift,
    rule: wait?.rule ?? null,
    ticks: wait?.ticks ?? 0,
    heldTicks: wait?.heldTicks ?? 0,
    bytes: wait?.bytes ?? 0,
    screenTail:
      screenTail === null ? null : screenTail.slice(-SCREEN_TAIL_CHARS),
  });
  if (records.length > MAX_RECORDS)
    records.splice(0, records.length - MAX_RECORDS);
}

/** Every opening still remembered, oldest first. */
export function sessionOpeningRecords(): readonly SessionOpeningRecord[] {
  return [...records];
}

/** Drop everything, for a test or a fresh measurement. */
export function resetSessionOpeningRecords(): void {
  pending.clear();
  records.length = 0;
  sequence = 0;
}
