import { LazyStore } from "@tauri-apps/plugin-store";
import type { WireRemoteReposPayload } from "@/lib/native";
import { type ActivityCursor, parseActivityCursor } from "./activity";

/**
 * The repository list as it was last read, kept in `verta-remotes.json` for the next window.
 *
 * Opening the panel used to mean waiting for `gh repo list` before anything could be drawn. The
 * list is now drawn from what it read last and the read that runs right after settles it. A tab
 * that is closed and opened again needs nothing from here, since `WorkspaceSurface` keeps both
 * lists in fixed layers and never unmounts them; what this store covers is the next window.
 *
 * A result that is not `ready` describes the machine at that moment (gh missing, nobody logged in)
 * rather than the account's repositories, so it is never written: the next window should still
 * open on the last real list, and then find out for itself what the account looks like now.
 */
const STORE_PATH = "verta-remotes.json";
const KEY_PAYLOAD = "payload";

export type RepoSnapshot = {
  /** When the read behind `payload` came back, epoch ms. */
  readonly at: number;
  readonly payload: WireRemoteReposPayload;
};

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 500 });

/** The last `ready` list, from the window before this one. */
export async function readRepoSnapshot(): Promise<RepoSnapshot | null> {
  const raw = await store.get<unknown>(KEY_PAYLOAD).catch(() => null);
  return parseRepoSnapshot(raw);
}

/** Keep a list for the next window. Only a `ready` one says anything about the account. */
export function rememberRepoSnapshot(snapshot: RepoSnapshot): void {
  if (snapshot.payload.kind !== "ready") return;
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

/**
 * When each repository was last looked at, in the same file as the list.
 *
 * A mark answers "has anything happened here since I last looked", which is a fact about this
 * person rather than about the account, so it outlives the window the way the list does. It sits
 * beside the list rather than in its own file so that the two are written together and cannot
 * describe different moments.
 *
 * Empty maps are written too: clearing a mark is a normal thing to do (the window read the
 * repository and found nothing new), and skipping that write would leave the file claiming
 * something was read that this window never saw.
 */
const KEY_ACTIVITY_CURSOR = "activityCursor";

/** Last look per repository, from the window before this one. */
export async function readActivityCursor(): Promise<ActivityCursor> {
  const raw = await store.get<unknown>(KEY_ACTIVITY_CURSOR).catch(() => null);
  return parseActivityCursor(raw);
}

/** Keep the marks for the next window. */
export function rememberActivityCursor(cursor: ActivityCursor): void {
  void store
    .set(KEY_ACTIVITY_CURSOR, cursor)
    .then(() => store.save())
    .catch(() => undefined);
}