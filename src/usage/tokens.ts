/**
 * The usage window's own accounting, mirroring Rust's `TokenScope::counted`.
 *
 * The command already returns a count for the scope it was asked for, and every row carries the
 * same parts beside it. Recomputing here is what makes ticking "cache reads" out and back in a
 * re-render instead of a second read of every store on the machine (5.6 GB of opencode plus the
 * transcripts), and it is safe to have two implementations because the probe checks the two agree
 * on the first answer (`window.__vertaUsage()`).
 */

/** Tokens one row used, in the classes the tools themselves separate. */
export type UsageParts = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** A total the tool reported without a breakdown (pi's `totalTokens`, opencode's `total`). */
  unsplit: number;
};

/** Which token classes a number counts. */
export type TokenScope = {
  cacheRead: boolean;
  cacheWrite: boolean;
};

export type UsageDayRow = {
  /** Days since 1970-01-01, in the payload's offset. */
  day: number;
  /** `YYYY-MM-DD`, computed by Rust so this side never does date arithmetic. */
  label: string;
  parts: UsageParts;
  tokens: number;
  events: number;
};

export type UsageModelRow = {
  provider: string | null;
  model: string | null;
  parts: UsageParts;
  tokens: number;
  events: number;
};

export type UsagePayload = {
  sinceMs: number | null;
  offsetMinutes: number;
  scope: TokenScope;
  parts: UsageParts;
  tokens: number;
  events: number;
  excludedCacheRead: number;
  excludedCacheWrite: number;
  /** Oldest first. */
  days: UsageDayRow[];
  /** Biggest first. */
  models: UsageModelRow[];
  failures: string[];
};

/**
 * How many tokens these parts are worth under this scope.
 *
 * Unsplit tokens are always counted: the tool reported them as spent, there is just nothing to
 * attribute them to. Cache reads and writes are the two that people argue about, so they are the
 * two the window offers a switch for.
 */
export function countTokens(parts: UsageParts, scope: TokenScope): number {
  let total = parts.input + parts.output + parts.reasoning + parts.unsplit;
  if (scope.cacheRead) total += parts.cacheRead;
  if (scope.cacheWrite) total += parts.cacheWrite;
  return total;
}

/**
 * The payload holds one scope's counts and the parts they came from. This rebuilds every count for
 * a different scope, so the answer and the rows stay consistent with each other.
 */
export function withScope(
  payload: UsagePayload,
  scope: TokenScope,
): UsagePayload {
  return {
    ...payload,
    scope,
    tokens: countTokens(payload.parts, scope),
    excludedCacheRead: scope.cacheRead ? 0 : payload.parts.cacheRead,
    excludedCacheWrite: scope.cacheWrite ? 0 : payload.parts.cacheWrite,
    days: payload.days.map((day) => ({
      ...day,
      tokens: countTokens(day.parts, scope),
    })),
    models: payload.models.map((row) => ({
      ...row,
      tokens: countTokens(row.parts, scope),
    })),
  };
}

/** The offset a local day needs, in minutes east of UTC. */
export function localOffsetMinutes(at: Date = new Date()): number {
  // `getTimezoneOffset` is minutes *behind* UTC (UTC+8 gives -480), which is the opposite sign of
  // the offset the Rust side wants.
  return -at.getTimezoneOffset();
}

/** The start of a range that spans `days` days, or `null` for everything on the machine. */
export function sinceForDays(
  days: number,
  now: number = Date.now(),
): number | null {
  if (days <= 0) return null;
  return now - days * 24 * 60 * 60 * 1000;
}
