import type { AgentSession } from "@/modules/launcher";
import { envForPath, LOCAL_WORKSPACE } from "@/modules/workspace";
import { mergeProjectPaths, normalizePath, samePath } from "./paths";
import type { ProjectEntry } from "./types";

/**
 * 清单里的路径 → 界面条目。环境按路径反推：盘上的项目是本机，用户手填的 Linux 路径
 * 属于某个发行版（`envForPath` 会用「上次用过的发行版」兜底）。
 */
export function entriesFromPaths(paths: string[]): ProjectEntry[] {
  return paths.map((path) => ({
    path,
    workspace: envForPath(path, LOCAL_WORKSPACE),
    managed: true,
  }));
}

/**
 * 从会话里发现的项目：打开 WSL 开关时，各发行版会话的 cwd 去重后并入列表，
 * 这样发行版里的会话也有项目行可挂。它们不是清单成员，界面不给「移除」。
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