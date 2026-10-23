import type { Language } from "@/modules/i18n/language";
import { translate } from "@/modules/i18n/messages";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ABSOLUTE_AFTER_DAYS = 30;

/**
 * How long ago something happened, in words for the first day and as a date
 * after that.
 *
 * `language` is optional so the pure formatting stays callable from places
 * that have no preferences store (tests, fixtures); the UI always passes the
 * language it renders in.
 */
export function relativeTime(
  nowMs: number,
  updatedAtMs: number,
  language: Language = "zh",
): string {
  if (!updatedAtMs || updatedAtMs <= 0) return translate(language, "time.unknown");
  const age = nowMs - updatedAtMs;
  // A clock that went backwards (or a system time change) must not print a
  // negative age.
  if (age < MINUTE) return translate(language, "time.justNow");
  if (age < HOUR)
    return translate(language, "time.minutesAgo", {
      count: Math.floor(age / MINUTE),
    });
  if (age < DAY)
    return translate(language, "time.hoursAgo", {
      count: Math.floor(age / HOUR),
    });
  const days = Math.floor(age / DAY);
  if (days < ABSOLUTE_AFTER_DAYS)
    return translate(language, "time.daysAgo", { count: days });
  const date = new Date(updatedAtMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}