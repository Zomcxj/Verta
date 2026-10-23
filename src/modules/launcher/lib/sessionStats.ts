import type { Language } from "@/modules/i18n/language";
import { translate } from "@/modules/i18n/messages";

/**
 * The three numbers on a session row: turns, tokens, and the last conversation
 * time (down to the day).
 *
 * The backend reports `null` (not 0) when a value is unavailable, and the UI must
 * show "—": passing 0 off as real would suggest the session never said a word.
 */

export type SessionStats = {
  turns: number | null;
  tokens: number | null;
  /** Time of the last **conversation**; falls back to the file mtime (`updatedAtMs`). */
  lastAtMs: number | null;
};

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Turn count, e.g. `12 turns`; `—` when unknown. */
export function turnsLabel(
  turns: number | null | undefined,
  language: Language = "zh",
): string {
  if (turns === null || turns === undefined || turns < 0) return "—";
  return translate(language, "stats.turns", { count: turns });
}

/**
 * Tokens: written out below ten thousand, folded to `12.3 k` above that, and to
 * `1.2 M` in the millions.
 *
 * Sessions routinely reach hundreds of thousands of tokens; the raw number is too
 * long to read the magnitude off.
 */
export function tokensLabel(
  tokens: number | null | undefined,
  language: Language = "zh",
): string {
  if (tokens === null || tokens === undefined || tokens < 0) return "—";
  if (tokens < 10_000)
    return translate(language, "stats.tokens", { count: tokens });
  if (tokens < 1_000_000) {
    const wan = tokens / 10_000;
    return translate(language, "stats.tokensTenThousand", {
      value: wan >= 100 ? Math.round(wan) : wan.toFixed(1),
    });
  }
  const million = tokens / 1_000_000;
  return translate(language, "stats.tokensMillion", {
    value: million >= 100 ? Math.round(million) : million.toFixed(1),
  });
}

/**
 * Last conversation time, nearest first:
 * `just now` → `N minutes ago` → `N hours ago` (steps 1/3/6/12) → `yesterday` →
 * `day before` → `2026-10-08`.
 *
 * The closer it is, the more precisely "how long ago" matters: minutes within the
 * hour, hours within the day (nearest step), and only beyond that does the date
 * become worth reading — the day of the month is easier to grasp than a day count.
 *
 * Both `nowMs` and `ms` use local time for day boundaries. Future timestamps (a
 * skewed clock) read as "just now" rather than a negative age.
 */
export function lastTalkedDayLabel(
  nowMs: number,
  ms: number | null | undefined,
  language: Language = "zh",
): string {
  if (!ms || ms <= 0) return "—";
  const elapsed = nowMs - ms;
  // Clock skew or a future timestamp: treat it as just now, never "-3 hours ago".
  if (elapsed < MINUTE) return translate(language, "time.justNow");

  const day = (value: number) => {
    const date = new Date(value);
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  };
  const diffDays = Math.round((day(nowMs) - day(ms)) / DAY);

  // Within today: snap hours to the nearest step (1/3/6/12) so the numbers on one
  // screen stay comparable.
  if (diffDays <= 0) {
    const hours = Math.floor(elapsed / HOUR);
    if (hours < 1)
      return translate(language, "time.minutesAgo", {
        count: Math.floor(elapsed / MINUTE),
      });
    return translate(language, "time.hoursAgoStep", {
      count: nearestHourStep(hours),
    });
  }
  if (diffDays === 1) return translate(language, "time.yesterday");
  if (diffDays === 2) return translate(language, "time.dayBeforeYesterday");
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Snap an hour count to the 1 / 3 / 6 / 12 steps; "7 hours ago" is precision
 * nobody cares about.
 *
 * Snap to the **nearest** step (round), not upward: 2.9 hours as "3 hours ago" is
 * fine, but rounding 5 up to 6 would overstate it — 5 is already closest to 6.
 */
function nearestHourStep(hours: number): number {
  // Boundaries sit at the midpoints, so each range rounds to whichever step it is
  // closer to.
  if (hours < 2) return 1;
  if (hours < 5) return 3;
  if (hours < 9) return 6;
  return 12;
}

/** Backend stats plus fallbacks: use the mtime when there is no conversation time,
 * leave the rest empty. */
export function statsOf(session: {
  turns?: number | null;
  tokens?: number | null;
  lastAtMs?: number | null;
  updatedAtMs: number;
}): SessionStats {
  return {
    turns: session.turns ?? null,
    tokens: session.tokens ?? null,
    lastAtMs: session.lastAtMs ?? session.updatedAtMs ?? null,
  };
}
