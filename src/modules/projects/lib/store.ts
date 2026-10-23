import { LazyStore } from "@tauri-apps/plugin-store";
import { mergeProjectPaths } from "./paths";

// The project list lives in plugin-store like workspaces did: an ordered path list the
// user maintains.
const STORE_PATH = "verta-projects.json";
const KEY_PROJECTS = "projects";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 500 });

export async function loadProjectPaths(): Promise<string[]> {
  const raw = await store.get<string[]>(KEY_PROJECTS).catch(() => null);
  // A hand-edited store must not crash us: a non-array becomes an empty list, and the
  // rest is deduplicated and normalized on the way in.
  if (!Array.isArray(raw)) return [];
  return mergeProjectPaths(
    [],
    raw.filter((entry): entry is string => typeof entry === "string"),
  );
}

export async function saveProjectPaths(paths: string[]): Promise<void> {
  await store.set(KEY_PROJECTS, paths);
  await store.save();
}