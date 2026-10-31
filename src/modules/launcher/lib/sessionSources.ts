import type { AgentSession } from "./types";

/**
 * The rows each source last answered with, kept per source rather than as one list.
 *
 * Why this exists: a read of the sessions panel is many reads, one per source, and they answer at
 * very different times. Measured on this machine (2026-10-31): local opencode answers in 50 to
 * 150 ms and local pi in about 2.6 to 3.3 s, a distro in 0.8 to 1.0 s. The panel used to rebuild
 * the whole list out of the sources that had answered so far, so the moment the fast source landed
 * the slow source's rows left the list and came back seconds later. Measured with the panel's own
 * Refresh pressed while the list was sampled every 10 ms: 13 rows, and at t+2.08 s the four local
 * pi rows (`c1e59274`, `7dea4b63`, `59950705`, `25c17ca9`) were gone, back at t+4.67 s.
 *
 * That is not only a manual refresh: the backend reports every write to either session store, so
 * while a session is being written the hole opens over and over - which is how it was reported
 * ("four sessions in the list keep disappearing and coming back").
 *
 * Keeping the rows per source makes a read replace the source that answered and nothing else. The
 * two edges are what the helpers below are for: a source that stops being asked (the WSL toggle
 * went off) is dropped with its rows, and a source that failed is dropped too, because rows from
 * the previous read would claim a store that could not be read at all is unchanged.
 */
export type SourceRows<T> = ReadonlyMap<string, readonly T[]>;

/** No source has answered yet. */
export function noSourceRows<T>(): SourceRows<T> {
  return new Map<string, readonly T[]>();
}

/**
 * The cache with one source's rows replaced.
 *
 * A source that answers with nothing still replaces its rows: an empty answer is an answer, and
 * keeping the previous read's rows would show sessions that are no longer there.
 */
export function withSourceRows<T>(
  rows: SourceRows<T>,
  source: string,
  next: readonly T[],
): SourceRows<T> {
  const updated = new Map(rows);
  updated.set(source, next);
  return updated;
}

/** The cache with one source's rows dropped: it failed to answer, or a row action changed it. */
export function withoutSource<T>(
  rows: SourceRows<T>,
  source: string,
): SourceRows<T> {
  if (!rows.has(source)) return rows;
  const updated = new Map(rows);
  updated.delete(source);
  return updated;
}

/**
 * The cache with the rows of every source a read is no longer asking for dropped.
 *
 * The toggle is the case this is for: with WSL off the distros are not asked, and their rows must
 * not stay in the list as though they had been.
 */
export function keptSources<T>(
  rows: SourceRows<T>,
  asked: ReadonlySet<string>,
): SourceRows<T> {
  let updated: Map<string, readonly T[]> | null = null;
  for (const source of rows.keys()) {
    if (asked.has(source)) continue;
    updated ??= new Map(rows);
    updated.delete(source);
  }
  return updated ?? rows;
}

/**
 * Every source's rows as one list, newest first.
 *
 * The sources are walked in a fixed order (their keys, sorted) rather than in the order they
 * happened to answer: the list is redrawn on every settle, and a source answering in a different
 * order on the next read would otherwise reshuffle rows that are equally recent and make the list
 * move for no reason.
 */
export function allRows(
  rows: SourceRows<AgentSession>,
  newestFirst: (left: AgentSession, right: AgentSession) => number,
): AgentSession[] {
  const merged: AgentSession[] = [];
  for (const source of [...rows.keys()].sort()) {
    merged.push(...(rows.get(source) ?? []));
  }
  // `sort` is stable, so rows of equal age keep the order their own source gave them.
  merged.sort(newestFirst);
  return merged;
}

/** Newest first, the order the list draws and the order the backend reads in. */
export const byNewestFirst = (
  left: AgentSession,
  right: AgentSession,
): number => right.updatedAtMs - left.updatedAtMs;
