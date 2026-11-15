import { LazyStore } from "@tauri-apps/plugin-store";
import type { UsagePayload } from "./tokens";

/**
 * The last read, kept so the window can answer before it has read the machine again.
 *
 * Reading walks every agent store on the disk and takes seconds; a window that opens empty with
 * "读取中…" in it is answering a question it answered a minute ago. So the previous answer is kept
 * beside the settings, painted first, and replaced by the live one when that lands.
 *
 * What it is not is a second source of truth. It carries the instant it was read, the window says
 * what that instant is, and a stored object that does not look like a payload this build understands
 * is dropped rather than drawn as a half-filled window: a stale number the reader can date is worth
 * showing, a shape guessed from an older build is not.
 */
const STORE_PATH = "verta-usage-cache.json";
const KEY_LAST = "last";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 400 });

export type CachedUsage = {
  payload: UsagePayload;
  /** When that payload was read, so the window can date what it is showing. */
  at: number;
};

/**
 * What a stored object has to be to be shown.
 *
 * Only the fields nothing can be drawn without are checked, and the check is a gate rather than a
 * repair: a payload written by another build may carry a model row this one cannot read, so the
 * whole object is dropped and the window waits the few seconds instead of painting something wrong.
 */
export function usableCache(raw: unknown): CachedUsage | null {
  if (raw === null || typeof raw !== "object") return null;
  const { payload, at } = raw as Partial<CachedUsage>;
  if (payload === null || typeof payload !== "object") return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (!Array.isArray(payload.days)) return null;
  if (typeof payload.offsetMinutes !== "number") return null;
  if (typeof payload.tokens !== "number") return null;
  return { payload, at };
}

/** The previous read, or nothing. A store that cannot be read is not a reason to fail the window. */
export async function loadUsageCache(): Promise<CachedUsage | null> {
  try {
    return usableCache(await store.get(KEY_LAST));
  } catch {
    return null;
  }
}

/** Best effort: the window has already painted the live answer by the time this lands. */
export async function saveUsageCache(
  payload: UsagePayload,
  at: number,
): Promise<void> {
  try {
    await store.set(KEY_LAST, { payload, at });
  } catch {
    // Nothing to do and nothing to tell: the next open simply reads the machine again.
  }
}
