import { LazyStore } from "@tauri-apps/plugin-store";
import type { WireProjectStatus } from "@/lib/native";

/**
 * The statuses of the last check, kept in memory for this window and on disk for the next
 * one.
 *
 * Every visit to the panel used to start from nothing: the rows read "not checked" until a
 * batch of git reads came back, even when nothing had changed since the visit before. The
 * panel now draws what it remembers and checks right after that, which is why the snapshot
 * has to outlive the panel (the memory copy, for a tab that was closed and opened again)
 * and the window (the disk copy, for a restart).
 *
 * Only the statuses are remembered. The list itself belongs to the user, and it sits in its
 * own key of the same file.
 */
const STORE_PATH = "verta-projects.json";
const KEY_STATUSES = "statuses";

export type StatusSnapshot = {
  /** When the check behind `statuses` finished, epoch ms. */
  readonly at: number;
  /** One status per normalized project path, the way the panel keys them. */
  readonly statuses: Record<string, WireProjectStatus>;
};

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 500 });

let remembered: StatusSnapshot | null = null;

/** The snapshot this window already holds, for the panel's first paint. */
export function readStatusSnapshotMemory(): StatusSnapshot | null {
  return remembered;
}

/**
 * The snapshot from the last window. A hand-edited or half-written file is not worth an
 * error: it becomes "nothing remembered", and the check that runs anyway corrects it.
 */
export async function readStatusSnapshot(): Promise<StatusSnapshot | null> {
  const raw = await store.get<unknown>(KEY_STATUSES).catch(() => null);
  return parseStatusSnapshot(raw);
}

/**
 * Keep a snapshot: in memory right away, and on disk without waiting. The disk write is
 * deliberately not awaited, since it is on the path to the next paint, and a failure here
 * costs the next window's head start rather than anything the user asked for.
 */
export function rememberStatuses(snapshot: StatusSnapshot): void {
  const unchanged =
    remembered?.at === snapshot.at &&
    remembered.statuses === snapshot.statuses;
  // The panel calls this whenever its state changes, including the first render after it
  // seeded itself from memory: writing that one again would rewrite the same bytes.
  remembered = snapshot;
  if (unchanged) return;
  void store
    .set(KEY_STATUSES, snapshot)
    .then(() => store.save())
    .catch(() => undefined);
}

/** Drop the statuses of projects that are no longer on the list. */
export function forgetStatuses(paths: readonly string[]): void {
  if (!remembered || paths.length === 0) return;
  const statuses = { ...remembered.statuses };
  for (const path of paths) delete statuses[path];
  rememberStatuses({ at: remembered.at, statuses });
}

/** Pure validation of what the store holds, so a bad file cannot reach the panel. */
export function parseStatusSnapshot(raw: unknown): StatusSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const { at, statuses } = raw as { at?: unknown; statuses?: unknown };
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (!statuses || typeof statuses !== "object") return null;
  const kept: Record<string, WireProjectStatus> = {};
  for (const [path, value] of Object.entries(statuses)) {
    if (!value || typeof value !== "object") continue;
    const status = value as WireProjectStatus;
    // The path inside the status is what the row reads; an entry without one is junk.
    if (typeof status.path !== "string") continue;
    kept[path] = status;
  }
  return { at, statuses: kept };
}

/** Forget the memory copy. Disk state stays, so tests can read it back. */
export function resetStatusStore(): void {
  remembered = null;
}