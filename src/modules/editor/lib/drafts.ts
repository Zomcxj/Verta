import { LazyStore } from "@tauri-apps/plugin-store";

/**
 * Draft backups for unsaved content.
 *
 * Editor auto-save is off by default (`editorAutoSave: false`), so closing a tab,
 * the process being killed, or a reboot would drop the buffer and its edits
 * together. After every change the buffer is mirrored into a store: the next time
 * the same file is opened, if the on-disk content differs from the draft, the user
 * is offered a restore.
 *
 * The caps are deliberate: this is a "do not lose things" safety net, not a
 * version store. A single oversized draft is skipped, and older ones are dropped
 * first when the limits are exceeded.
 */
const STORE_PATH = "verta-drafts.json";
const KEY = "drafts";

export const MAX_DRAFT_BYTES = 1024 * 1024;
export const MAX_DRAFTS = 8;
export const MAX_DRAFT_TOTAL_BYTES = 4 * 1024 * 1024;

export type Draft = {
  text: string;
  /** When the draft was recorded, so the prompt can say when the work was interrupted. */
  at: number;
};

export type DraftMap = Record<string, Draft>;

/**
 * Draft key: normalize separators but do not fold case.
 *
 * In WSL `/home/x/File` and `/home/x/file` are two different files, and folding case
 * would offer a draft for the wrong one; on the local side, differing case only
 * leaves one extra stale draft behind — at worst one glance too many.
 */
export function draftKey(path: string): string {
  return path.trim().replace(/\\/g, "/");
}

/** Whether the draft is worth offering: only if it differs from what is on disk. */
export function draftOffersRecovery(
  draft: Draft | null | undefined,
  fileText: string,
): boolean {
  return draft != null && draft.text !== fileText;
}

/** Trim to the caps: keep the newest, drop older ones once count or total size is exceeded. */
export function pruneDrafts(map: DraftMap): DraftMap {
  const newestFirst = Object.entries(map).sort((a, b) => b[1].at - a[1].at);
  const kept: DraftMap = {};
  let total = 0;
  for (const [key, draft] of newestFirst) {
    if (Object.keys(kept).length >= MAX_DRAFTS) break;
    const size = draft.text.length;
    if (size > MAX_DRAFT_BYTES) continue;
    if (total + size > MAX_DRAFT_TOTAL_BYTES) break;
    kept[key] = draft;
    total += size;
  }
  return kept;
}

/** Store one draft; returns the map unchanged when it cannot fit (keeping the old
 * draft beats keeping nothing). */
export function putDraft(
  map: DraftMap,
  key: string,
  text: string,
  at: number,
): DraftMap {
  if (text.length > MAX_DRAFT_BYTES) return map;
  return pruneDrafts({ ...map, [key]: { text, at } });
}

/** Drop one draft (after a successful save, or when the user chooses to discard it). */
export function removeDraft(map: DraftMap, key: string): DraftMap {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** A hand-edited store must not crash us: drop entries with the wrong shape. */
function normalizeMap(raw: unknown): DraftMap {
  if (!raw || typeof raw !== "object") return {};
  const out: DraftMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { text, at } = value as { text?: unknown; at?: unknown };
    if (typeof text !== "string" || typeof at !== "number") continue;
    out[key] = { text, at };
  }
  return pruneDrafts(out);
}

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 400 });

let cache: DraftMap | null = null;

async function readMap(): Promise<DraftMap> {
  if (cache) return cache;
  const raw = await store.get<DraftMap>(KEY).catch(() => null);
  cache = normalizeMap(raw);
  return cache;
}

/**
 * Chain writes into a single queue so each change does one read-modify-write and two
 * concurrent ones cannot overwrite each other.
 */
let queue: Promise<void> = Promise.resolve();

function enqueue(job: () => Promise<void>): Promise<void> {
  const next = queue.then(job, job);
  queue = next.catch(() => {});
  return next;
}

export async function readDraft(path: string): Promise<Draft | null> {
  const map = await readMap();
  return map[draftKey(path)] ?? null;
}

export async function storeDraft(
  path: string,
  text: string,
  at: number = Date.now(),
): Promise<void> {
  const key = draftKey(path);
  return enqueue(async () => {
    const map = await readMap();
    const next = putDraft(map, key, text, at);
    if (next === map) return;
    cache = next;
    await store.set(KEY, next);
    await store.save();
  });
}

export async function dropDraft(path: string): Promise<void> {
  const key = draftKey(path);
  return enqueue(async () => {
    const map = await readMap();
    const next = removeDraft(map, key);
    if (next === map) return;
    cache = next;
    await store.set(KEY, next);
    await store.save();
  });
}