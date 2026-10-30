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
/** Repository full name -> when it was last looked at, ISO8601. */
export type ActivityMark = string;

/**
 * How long an answer to "anything new here" is worth trusting.
 *
 * Long enough that moving the pointer across a list does not fire a gh call per row, short enough
 * that coming back to a repository a minute later asks again. It applies to failures too: a row
 * whose read failed would otherwise spawn a gh process on every hover pass.
 */
export const ACTIVITY_FRESH_MS = 60_000;

/** Is a stored answer still worth using, or is it time to ask again? */
export function answerFresh(
  cachedAt: number | null | undefined,
  now: number,
): boolean {
  if (typeof cachedAt !== "number" || !Number.isFinite(cachedAt)) return false;
  return now - cachedAt < ACTIVITY_FRESH_MS;
}

/**
 * Whichever of the two is later, falling back to `fallback` when `other` is not a time.
 *
 * The two sides come from different clocks: a mark is this machine's, the activity answer is
 * GitHub's. A machine whose clock lags would otherwise write a mark *older* than the item it just
 * read, leaving the dot lit on something already seen with nothing to clear it.
 */
export function laterOf(
  fallback: string,
  other: string | null | undefined,
): string {
  const otherAt = timeOf(other);
  if (otherAt === null) return fallback;
  const fallbackAt = timeOf(fallback);
  if (fallbackAt === null || fallbackAt >= otherAt) return fallback;
  return other as string;
}

/**
 * Move one repository's mark when the repository is renamed.
 *
 * Marks are keyed by `owner/name`, and a rename is a different name. Without this the old key sits
 * in the file forever and the new name looks like a repository nobody has ever read - a dot that
 * appears out of nothing on something already seen.
 */
export function renameRepo(
  cursor: ActivityCursor,
  from: string,
  to: string,
): ActivityCursor {
  if (!from || !to || from === to) return cursor;
  const mark = cursor[from];
  if (mark === undefined) return cursor;
  const next: ActivityCursor = { ...cursor, [to]: mark };
  delete next[from];
  return next;
}
