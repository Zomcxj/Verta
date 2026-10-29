import { invoke } from "@tauri-apps/api/core";

let cached: string | undefined;
let explicit = false;

/**
 * Read the directory this launch was handed, if any.
 *
 * Only the argument counts. The app's own launch directory used to fill in when there was none, which is
 * what made every start land somewhere rather than where the environment says a terminal starts; a launch
 * without an argument has no directory of its own, and the backend picks.
 */
export async function initLaunchDir(): Promise<void> {
  const fromArgs = await invoke<string | null>("get_launch_dir").catch(() => null);
  // An argument is a request to work there rather than a hint about where a session would like to start.
  explicit = fromArgs != null;
  cached = fromArgs ? fromArgs.replace(/\\/g, "/") : undefined;
}

export function getLaunchDir(): string | undefined {
  return cached;
}

/**
 * Whether the folder above came from an argument. A folder the user opened from Explorer is a request to
 * work there, not just where the next session would start, so it gets opened rather than merely remembered.
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
