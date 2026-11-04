import { LazyStore } from "@tauri-apps/plugin-store";
import type { SerializedTab } from "./serialize";

export type TabState = {
  tabs: SerializedTab[];
  activeTabIndex: number;
};

/** The desktop build keeps a single tab list, no longer split per workspace. */
const STORE_PATH = "verta-tabs.json";
const KEY_STATE = "state";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 500 });

/**
 * The list the last window left behind, or `null` when nothing was ever saved
 * (a fresh install). Whether a launch acts on it is the `restoreTabsOnLaunch`
 * preference, decided in `useTabRestore`; this file only reads and writes.
 */
export async function loadTabState(): Promise<TabState | null> {
  const state = await store.get<TabState>(KEY_STATE);
  if (!state || !Array.isArray(state.tabs)) return null;
  return state;
}

export async function saveTabState(state: TabState): Promise<void> {
  await store.set(KEY_STATE, state);
}
