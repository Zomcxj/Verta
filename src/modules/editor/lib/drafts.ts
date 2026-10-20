import { LazyStore } from "@tauri-apps/plugin-store";

/**
 * 未保存内容的草稿备份。
 *
 * 编辑器的自动保存默认是关的（`editorAutoSave: false`），所以关掉标签页、进程被杀、
 * 或者机器重启都会把缓冲区连同改动一起丢掉。这里在改动之后把缓冲区镜像一份进 store：
 * 下次打开同一个文件时，如果磁盘内容与草稿不同，就提示用户恢复。
 *
 * 上限是刻意的：这是「别丢东西」的安全网，不是版本库。单份超限就不收，多了丢最旧的。
 */
const STORE_PATH = "verta-drafts.json";
const KEY = "drafts";

export const MAX_DRAFT_BYTES = 1024 * 1024;
export const MAX_DRAFTS = 8;
export const MAX_DRAFT_TOTAL_BYTES = 4 * 1024 * 1024;

export type Draft = {
  text: string;
  /** 记草稿的时刻，用来在提示里说清是哪一刻中断的。 */
  at: number;
};

export type DraftMap = Record<string, Draft>;

/**
 * 草稿的键：统一分隔符，但不折叠大小写。
 *
 * WSL 那边 `/home/x/File` 与 `/home/x/file` 是两个文件，折叠了会把草稿提示到错的
 * 文件上；本机大小写不同也只多留一份旧草稿，最坏是多看一眼。
 */
export function draftKey(path: string): string {
  return path.trim().replace(/\\/g, "/");
}

/** 草稿还值不值得提示：内容跟磁盘不一样才有意义。 */
export function draftOffersRecovery(
  draft: Draft | null | undefined,
  fileText: string,
): boolean {
  return draft != null && draft.text !== fileText;
}

/** 按上限裁一遍：最新的先留，超份数或超总量就丢旧的。 */
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

/** 收一份草稿；大得装不下时原样返回（旧草稿留着比什么都不留好）。 */
export function putDraft(
  map: DraftMap,
  key: string,
  text: string,
  at: number,
): DraftMap {
  if (text.length > MAX_DRAFT_BYTES) return map;
  return pruneDrafts({ ...map, [key]: { text, at } });
}

/** 去掉某份草稿（保存成功或用户选择丢弃时）。 */
export function removeDraft(map: DraftMap, key: string): DraftMap {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** 存档被手改坏过也不能崩：形状不对的条目直接丢掉。 */
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
 * 写盘串成一条链：一次改动只做一次「读-改-写」，并发的两次不会互相盖掉。
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