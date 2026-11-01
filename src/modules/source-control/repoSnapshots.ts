/**
 * The last known status of each repository, kept so switching back to a tab paints instead of
 * waiting.
 *
 * The problem this solves was measured on this machine: switching into another repository left the
 * file list empty for **5.7 s**, while `git status` plus the two `numstat` reads cost 0.32 s. The
 * time was spent before the first paint, not in git. Two things were in front of it (a synchronous
 * fetch, since moved behind the paint) and the panel had nothing to show in the meantime because
 * it keeps only the repository it is currently on.
 *
 * A reference implementation (Coffee-CLI, AGPL, read only - nothing here is copied from it) keeps
 * a snapshot per repository and renders it immediately on a switch, then confirms it with a live
 * read. That shape is what this module provides; the code is this project's own.
 *
 * What is kept is a *rendering* cache, never the truth: a hit paints, and the caller always starts
 * a live read afterwards. `ageMs` is on the entry so the caller can decide whether the hit is
 * fresh enough to skip waiting for that read to land.
 */

import type { GitRepoInfo, GitStatusSnapshot } from "@/lib/native";

export type RepoSnapshot = {
  repo: GitRepoInfo;
  status: GitStatusSnapshot | null;
  /** When the live read that produced this landed. */
  at: number;
};

/**
 * How long a snapshot may be painted before the live read is allowed to replace it.
 *
 * Not a TTL on the paint: a hit is painted however old it is, because an old list is still a
 * better answer than an empty one. This is only the bound within which the caller may treat the
 * hit as final.
 */
export const REPO_SNAPSHOT_TTL_MS = 30_000;

/** How many repositories are remembered; the least recently used is dropped past this. */
const REPO_SNAPSHOT_LIMIT = 12;

/**
 * A repository is identified by its own root, not by the path the panel was opened on: two sessions
 * in different subdirectories of one repository share its status.
 */
export function repoSnapshotKey(repoRoot: string, workspaceKey: string): string {
  const normalized = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const isWindows = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//");
  return `${workspaceKey}\0${isWindows ? normalized.toLowerCase() : normalized}`;
}

/**
 * The snapshots, most recently used last.
 *
 * A module-level map rather than component state: the point is to survive the panel unmounting
 * when the user switches away, which is exactly when React would drop per-component state.
 */
const snapshots = new Map<string, RepoSnapshot>();

export function rememberRepoSnapshot(key: string, snapshot: RepoSnapshot): void {
  // Delete before setting so a re-remembered repository moves to the end of the insertion order,
  // which is what makes the eviction below least-recently-used.
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  while (snapshots.size > REPO_SNAPSHOT_LIMIT) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
}

export function getRepoSnapshot(key: string): RepoSnapshot | undefined {
  const hit = snapshots.get(key);
  if (!hit) return undefined;
  // Touching it makes it the most recently used, so an actively visited repository is not evicted
  // by a burst of one-off switches.
  snapshots.delete(key);
  snapshots.set(key, hit);
  return hit;
}

/** Whether a snapshot is recent enough to be treated as the answer rather than a placeholder. */
export function isSnapshotFresh(snapshot: RepoSnapshot, now: number): boolean {
  return now - snapshot.at < REPO_SNAPSHOT_TTL_MS;
}

/** Only for tests: the module-level map outlives a test otherwise. */
export function clearRepoSnapshots(): void {
  snapshots.clear();
}
