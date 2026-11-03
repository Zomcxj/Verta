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
 * What the tab list is written down as, one key, one list.
 *
 * There is no reader here on purpose. A launch starts a fresh window (see `useTabRestore`), so the
 * list is memory for the next launch to decide about, not something boot restores; the load side of
 * this file - including the migration from the per-workspace `verta-spaces.json` that older versions
 * wrote - was only ever called by the restore that no longer runs.
 */
export async function saveTabState(state: TabState): Promise<void> {
  await store.set(KEY_STATE, state);
}