import { LazyStore } from "@tauri-apps/plugin-store";
import type { WorkspaceEnv } from "@/modules/workspace";
import type { SerializedTab } from "./serialize";

export type TabState = {
  tabs: SerializedTab[];
  activeTabIndex: number;
};

/** 桌面版只有一份标签列表，不再按空间分家。 */
const STORE_PATH = "verta-tabs.json";
const KEY_STATE = "state";

/**
 * 老版本按空间存标签（`state:<空间 id>`）的那个文件：只读一次做迁移，之后不碰它。
 * 文件留在磁盘上无害，删别人的文件才是麻烦。
 */
const LEGACY_STORE_PATH = "verta-spaces.json";
const LEGACY_KEY_SPACES = "spaces";
const LEGACY_KEY_ACTIVE = "activeId";
const LEGACY_STATE_PREFIX = "state:";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 500 });
const legacyStore = new LazyStore(LEGACY_STORE_PATH, {
  defaults: {},
  autoSave: 500,
});

export async function loadTabState(): Promise<TabState | null> {
  const state = await store.get<TabState>(KEY_STATE);
  if (!state || !Array.isArray(state.tabs)) return null;
  return state;
}

export async function saveTabState(state: TabState): Promise<void> {
  await store.set(KEY_STATE, state);
}

type LegacySpaceMeta = { id: string; env?: WorkspaceEnv };

export type LegacyTabState = TabState & { env: WorkspaceEnv | null };

/**
 * 从老文件里把「当时活动那个空间」的标签列表拿出来，顺手删掉那条键，让迁移只发生一次。
 *
 * 老数据里环境记在空间上，不在标签上，所以一并带出来当恢复时的兜底。
 */
export async function loadLegacyTabState(): Promise<LegacyTabState | null> {
  const spaces =
    (await legacyStore.get<LegacySpaceMeta[]>(LEGACY_KEY_SPACES)) ?? [];
  if (spaces.length === 0) return null;
  const activeId = await legacyStore.get<string | null>(LEGACY_KEY_ACTIVE);
  const active = spaces.find((s) => s.id === activeId) ?? spaces[0];
  const key = `${LEGACY_STATE_PREFIX}${active.id}`;
  const state = await legacyStore.get<TabState>(key);
  if (!state || !Array.isArray(state.tabs)) return null;
  await legacyStore.delete(key);
  return {
    tabs: state.tabs,
    activeTabIndex: state.activeTabIndex ?? 0,
    env: active.env ?? null,
  };
}
