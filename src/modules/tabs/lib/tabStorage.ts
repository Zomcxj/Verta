import { LazyStore } from "@tauri-apps/plugin-store";
import type { WorkspaceEnv } from "@/modules/workspace";
import type { SerializedTab } from "./serialize";

export type TabState = {
  tabs: SerializedTab[];
  activeTabIndex: number;
};

/** The desktop build keeps a single tab list, no longer split per workspace. */
const STORE_PATH = "verta-tabs.json";
const KEY_STATE = "state";

/**
 * The legacy file where older versions stored tabs per workspace (`state:<workspace
 * id>`): read once for migration and never touched again. Leaving the file on disk is
 * harmless; deleting someone else's file is what causes trouble.
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
 * Pull the tab list of the workspace that was active at the time out of the legacy
 * file and delete that key on the way, so the migration only happens once.
 *
 * In the old data the env was recorded on the workspace rather than the tab, so it is
 * carried out too as a fallback for the restore.
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
