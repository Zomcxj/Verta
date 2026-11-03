import { LazyStore } from "@tauri-apps/plugin-store";
import type { WireProjectStatus } from "@/lib/native";

/**
 * The statuses of the last check, kept in `verta-projects.json` so the next window can draw them.
 *
 * Opening the panel used to mean every row read "not checked" until a batch of git reads came
 * back. The panel now draws what it remembers and checks right after. What a closed and reopened
 * tab needs is already there: `WorkspaceSurface` keeps both lists in fixed layers and never
 * unmounts them, so the panel's own state outlives its tab and this store has one layer, the file,
 * which is read when the panel comes to the front.
 *
 * Only the statuses are remembered. The list itself belongs to the user, and it sits in its own
 * key of the same file.
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

/**
 * The snapshot from the last window. A hand-edited or half-written file is not worth an error:
 * it becomes "nothing remembered", and the check that runs anyway corrects it.
 */
export async function readStatusSnapshot(): Promise<StatusSnapshot | null> {
  const raw = await store.get<unknown>(KEY_STATUSES).catch(() => null);
  return parseStatusSnapshot(raw);
}

/**
 * Keep a snapshot for the next window. The write is deliberately not awaited, since it is on the
 * path to the next paint, and a failure here costs the next window's head start rather than
 * anything the user asked for.
 */
export function rememberStatuses(snapshot: StatusSnapshot): void {
  void store
    .set(KEY_STATUSES, snapshot)
    .then(() => store.save())
    .catch(() => undefined);
}

/**
 * Whether a change is one the panel has to re-read for.
 *
 * The predicate itself lives in `lib/repoPath` because the source control panel asks the same
 * question of the same events; a second copy here is how the two answers drift apart.
 */
export { changeTouchesRepo } from "@/lib/repoPath";

/** Drop the statuses of projects that are no longer on the list. */
export async function forgetStatuses(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const held = await readStatusSnapshot().catch(() => null);
  if (!held) return;
  const statuses = { ...held.statuses };
  let dropped = false;
  for (const path of paths) {
    if (!(path in statuses)) continue;
    delete statuses[path];
    dropped = true;
  }
  if (dropped) rememberStatuses({ at: held.at, statuses });
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