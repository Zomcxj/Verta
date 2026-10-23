import type { AgentSession } from "@/modules/launcher";
import { envForPath, LOCAL_WORKSPACE } from "@/modules/workspace";
import { mergeProjectPaths, normalizePath, samePath } from "./paths";
import type { ProjectEntry } from "./types";

/**
 * Paths in the list → UI entries. The env is inferred from the path: a project on a
 * drive is local, while a hand-typed Linux path belongs to some distro (`envForPath`
 * falls back to the last distro used).
 */
export function entriesFromPaths(paths: string[]): ProjectEntry[] {
  return paths.map((path) => ({
    path,
    workspace: envForPath(path, LOCAL_WORKSPACE),
    managed: true,
  }));
}

/**
 * Projects discovered from sessions: with the WSL toggle on, the cwds of distro
 * sessions are deduplicated and merged into the list, so sessions inside a distro have
 * a project row to hang off. They are not list members, and the UI offers no "remove".
 */
export function discoveredEntries(
  sessions: AgentSession[],
  managed: ProjectEntry[],
): ProjectEntry[] {
  const byDistro = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.distro) continue;
    if (!session.cwd) continue;
    const list = byDistro.get(session.distro) ?? [];
    list.push(session.cwd);
    byDistro.set(session.distro, list);
  }

  const out: ProjectEntry[] = [];
  for (const [distro, cwds] of byDistro) {
    for (const cwd of mergeProjectPaths([], cwds)) {
      const known = managed.some((entry) => samePath(entry.path, cwd));
      if (known || out.some((entry) => samePath(entry.path, cwd))) continue;
      out.push({
        path: normalizePath(cwd),
        workspace: { kind: "wsl", distro },
        managed: false,
      });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}