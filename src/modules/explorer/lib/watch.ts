import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentWorkspaceEnv } from "@/modules/workspace";

const FS_CHANGED_EVENT = "fs:changed";

type FsChangedPayload = { paths: string[] };

/**
 * `paths` are directories. `files` (open editor buffers) are reported by their
 * own path when their size or mtime moves, because the native watcher only
 * reports which directory changed.
 */
export type WatchAddOptions = {
  /**
   * Register directories the listing filter would drop, `.git` above all.
   *
   * Only the project panel asks for this: a pull moves a ref inside `.git` and touches no file the
   * root listing would notice, so that is where the change shows up. The explorer never sets it.
   */
  includeSkipped?: boolean;
};

export function watchAdd(
  paths: string[],
  files: string[] = [],
  options: WatchAddOptions = {},
): void {
  if (paths.length === 0 && files.length === 0) return;
  void invoke("fs_watch_add", {
    paths,
    files,
    includeSkipped: options.includeSkipped ?? null,
    workspace: currentWorkspaceEnv(),
  }).catch(() => {});
}

export function watchRemove(paths: string[], files: string[] = []): void {
  if (paths.length === 0 && files.length === 0) return;
  void invoke("fs_watch_remove", {
    paths,
    files,
    workspace: currentWorkspaceEnv(),
  }).catch(() => {});
}

export function listenFsChanged(
  handler: (paths: string[]) => void,
): Promise<() => void> {
  return getCurrentWebviewWindow().listen<FsChangedPayload>(
    FS_CHANGED_EVENT,
    (e) => handler(e.payload.paths),
  );
}

export function parentDir(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i <= 0) return path.slice(0, i + 1) || path;
  return path.slice(0, i);
}
