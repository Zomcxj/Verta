import { LazyStore } from "@tauri-apps/plugin-store";
import type { WireRemoteReposPayload } from "@/lib/native";

/**
 * The repository list as it was last read, kept in memory for this window and on disk for
 * the next one.
 *
 * Opening the panel used to mean waiting for `gh repo list` before anything could be drawn.
 * The list is now drawn from what was read last, and the read that runs right after settles
 * it, which is why the snapshot outlives the panel and the window.
 *
 * A result that is not `ready` describes the machine at that moment (gh missing, nobody
 * logged in) rather than the account's repositories, so it is held in memory for this
 * window only and never written to disk: the next window should still open on the last real
 * list, and then find out for itself what the account looks like now.
 */
const STORE_PATH = "verta-remotes.json";
const KEY_PAYLOAD = "payload";

export type RepoSnapshot = {
  /** When the read behind `payload` came back, epoch ms. */
  readonly at: number;
  readonly payload: WireRemoteReposPayload;
};

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 500 });

let remembered: RepoSnapshot | null = null;

/** The snapshot this window already holds, for the panel's first paint. */
export function readRepoSnapshotMemory(): RepoSnapshot | null {
  return remembered;
}

/** The last `ready` list, from the window before this one. */
export async function readRepoSnapshot(): Promise<RepoSnapshot | null> {
  const raw = await store.get<unknown>(KEY_PAYLOAD).catch(() => null);
  return parseRepoSnapshot(raw);
}

export function rememberRepoSnapshot(snapshot: RepoSnapshot): void {
  const samePayload = remembered?.payload === snapshot.payload;
  remembered = snapshot;
  // The panel calls this whenever its payload changes, including right after seeding from
  // memory, and that same list is already on disk.
  if (samePayload || snapshot.payload.kind !== "ready") return;
  void store
    .set(KEY_PAYLOAD, snapshot)
    .then(() => store.save())
    .catch(() => undefined);
}

/** Pure validation: only a `ready` payload is worth reopening the panel on. */
export function parseRepoSnapshot(raw: unknown): RepoSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const { at, payload } = raw as { at?: unknown; payload?: unknown };
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as WireRemoteReposPayload;
  if (candidate.kind !== "ready" || !Array.isArray(candidate.repos)) return null;
  return { at, payload: candidate };
}

/** Forget the memory copy. Disk state stays, so tests can read it back. */
export function resetRepoStore(): void {
  remembered = null;
}