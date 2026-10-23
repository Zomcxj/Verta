import { invoke } from "@tauri-apps/api/core";

let cached: string | undefined;
let explicit = false;

export async function initLaunchDir(): Promise<void> {
  const fromArgs = await invoke<string | null>("get_launch_dir").catch(() => null);
  const dir =
    fromArgs ?? (await invoke<string>("workspace_current_dir").catch(() => null));
  // The command drains its state, so this is the one place that can tell an argument
  // apart from the remembered workspace.
  explicit = fromArgs != null;
  cached = dir ? dir.replace(/\\/g, "/") : undefined;
}

export function getLaunchDir(): string | undefined {
  return cached;
}

/**
 * Whether the folder above came from an argument rather than from the last workspace.
 * A folder the user opened from Explorer is a request to work there, not just where the
 * next session would start, so it gets opened rather than merely remembered.
 */
export function didLaunchWithDir(): boolean {
  return explicit;
}

/**
 * Drains the files passed via the OS "Open With" action (CLI args on
 * Linux/Windows, macOS open-files event). Drained once so HMR / re-mounts
 * can't replay them. Returns [] when the app wasn't launched with a file.
 */
export async function consumeLaunchFiles(): Promise<string[]> {
  const files = await invoke<string[]>("get_launch_files").catch(() => []);
  return files.map((f) => f.replace(/\\/g, "/"));
}
