/**
 * The last read of one repo's list, kept for the lifetime of the window.
 *
 * Each of these panels re-read a repo every time it opened, and flipping between
 * two repos in the sidebar therefore spent the same requests again for no new
 * information. A snapshot is reused while it is younger than its TTL, and the
 * panels drop it whenever they change something themselves, so an action never
 * leaves a stale list behind.
 *
 * The value is opaque here: callers key it by what they read (repo, and the
 * filter for the lists that have one) and get back what they stored.
 */

/** Long enough to cover going back and forth, short enough that a list opened
 *  again later in the day is read fresh. */
export const LIST_SNAPSHOT_TTL_MS = 120_000;

/** Permission decides which buttons show; it changes when the user changes it,
 *  not while they browse, so it is worth holding on to for longer. */
export const PERMISSION_SNAPSHOT_TTL_MS = 600_000;

type Entry = { at: number; value: unknown };

const snapshots = new Map<string, Entry>();

export function readListSnapshot<T>(
  key: string,
  ttlMs: number = LIST_SNAPSHOT_TTL_MS,
  now: number = Date.now(),
): T | null {
  const hit = snapshots.get(key);
  if (!hit) return null;
  if (now - hit.at > ttlMs) {
    snapshots.delete(key);
    return null;
  }
  return hit.value as T;
}

export function writeListSnapshot<T>(
  key: string,
  value: T,
  now: number = Date.now(),
): void {
  snapshots.set(key, { at: now, value });
}

/** Drop one key (after an action changed that list, or its permission). */
export function forgetListSnapshot(key: string): void {
  snapshots.delete(key);
}

/** Drop everything, for tests and for a workspace switch. */
export function resetListSnapshots(): void {
  snapshots.clear();
}
