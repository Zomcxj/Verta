import { LazyStore } from "@tauri-apps/plugin-store";
import { mergeProjectPaths } from "./paths";

// 项目清单与空间一样放 plugin-store：用户自己维护的一份有序路径列表。
const STORE_PATH = "verta-projects.json";
const KEY_PROJECTS = "projects";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 500 });

export async function loadProjectPaths(): Promise<string[]> {
  const raw = await store.get<string[]>(KEY_PROJECTS).catch(() => null);
  // 存档被手改坏过也不能崩：不是数组就当空清单，并顺手去重规范化。
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