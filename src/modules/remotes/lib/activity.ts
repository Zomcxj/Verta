/**
 * Whether a repository has anything new to look at.
 *
 * The dot on a repository row answers one question: is the newest update among that repository's
 * open pull requests and issues later than the last time this person looked? "Later than" is the
 * whole rule - a new item, a comment, a review, a CI run turning red and a re-open all move the
 * same timestamp, so one comparison covers all of them.
 *
 * Marks are stored per repository as the ISO8601 string GitHub itself hands out, and are compared
 * as times rather than as strings: the offsets in two ISO strings are not guaranteed to agree.
 */

/** Repository full name -> when it was last looked at, ISO8601. */
export type ActivityCursor = Record<string, string>;

/** Epoch ms for a timestamp, or null when it is not one. */
function timeOf(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Is `latest` later than what was last seen?
 *
 * No answer (`latest` null) is not a claim: the dot stays off, because saying "there is something
 * new" when gh could not be read is worth less than saying nothing. A mark that is not a time is
 * treated as no mark at all - one extra dot is recoverable, a dot suppressed forever by a corrupt
 * value is not.
 */
export function isNewer(
  latest: string | null | undefined,
  cursor: string | null | undefined,
): boolean {
  const latestAt = timeOf(latest);
  if (latestAt === null) return false;
  const seenAt = timeOf(cursor);
  if (seenAt === null) return true;
  return latestAt > seenAt;
}

/**
 * Move one repository's mark forward to `at`, or return the map unchanged.
 *
 * Forwards only: reading an older item must not un-read a newer one, and a value that is not a
 * time is not a mark. The same map comes back untouched when nothing moves, so callers can tell
 * "nothing changed" by identity and skip a write.
 */
export function advanceCursor(
  cursor: ActivityCursor,
  repo: string,
  at: string,
): ActivityCursor {
  if (!repo || timeOf(at) === null) return cursor;
  if (!isNewer(at, cursor[repo])) return cursor;
  return { ...cursor, [repo]: at };
}

/**
 * What was on disk, keeping only the entries that could have been written by us.
 *
 * Everything here came from a JSON file that a previous version, a half-finished write or a hand
 * edit could have produced. Anything that is not a map of repository names to timestamps is
 * dropped rather than trusted: the next look fills the gaps back in.
 */
export function parseActivityCursor(raw: unknown): ActivityCursor {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: ActivityCursor = {};
  for (const [repo, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!repo) continue;
    if (typeof value !== "string" || timeOf(value) === null) continue;
    out[repo] = value;
  }
  return out;
}