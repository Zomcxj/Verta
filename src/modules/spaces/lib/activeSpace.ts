import { findLeaf } from "@/modules/terminal/lib/panes";
import type { Tab } from "@/modules/tabs";
import { envForPath, type WorkspaceEnv } from "@/modules/workspace";
import type { SpaceMeta } from "./store";

export function findActiveSpace(
  spaces: SpaceMeta[],
  activeId: string | null,
): SpaceMeta | null {
  if (activeId) {
    const found = spaces.find((s) => s.id === activeId);
    if (found) return found;
  }
  return spaces[0] ?? null;
}

export function activeSpaceEnv(
  spaces: SpaceMeta[],
  activeId: string | null,
): WorkspaceEnv {
  return findActiveSpace(spaces, activeId)?.env ?? { kind: "local" };
}

// 恢复过的标签用它自己的 home；新标签在**本机**与 **WSL** 两种情况下都返回 null——
// cwd 交给后端定：本机落桌面（`workspace::default_spawn_cwd`），WSL 落该发行版里当前用户的
// `$HOME`。这里曾经退回 `launchCwd`（Verta 自己的启动目录），终端里冒出一个安装目录是最费解的
// 一种落点；退回 `home` 也不是用户新开终端时想待的地方。
export function freshTabCwd(
  _env: WorkspaceEnv,
  restoredHome: string | null,
  _launchCwd: string | null,
  _home: string | null,
): string | null {
  return restoredHome;
}

/**
 * 恢复出来的标签现在在哪个环境：叶子自己记了就用它，只记了 cwd 就从路径反推。
 *
 * 存下来的 cwd 可能属于另一个环境（空间一直在本机，标签却停在发行版里）。不推的话，终端会带着
 * Linux 路径去本机启动，Rust 只能按「不可用」回退到家目录。
 */
export function tabEnvironment(
  tab: Tab,
  fallback: WorkspaceEnv,
): WorkspaceEnv | null {
  if (tab.kind !== "terminal") return null;
  const leaf = findLeaf(tab.paneTree, tab.activeLeafId);
  if (!leaf) return null;
  if (leaf.workspace) return leaf.workspace;
  return leaf.cwd ? envForPath(leaf.cwd, fallback) : null;
}
