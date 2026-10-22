import type { Tab } from "@/modules/tabs";

export type SourceControlRepositoryTarget =
  | { mode: "follow-context" }
  | { mode: "fixed"; repoRoot: string };

export type SourceControlRepositoryTargets = Readonly<Record<string, string>>;

const FOLLOW_CONTEXT: SourceControlRepositoryTarget = {
  mode: "follow-context",
};

function dirname(path: string | null): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index < 0) return normalized;
  if (index === 0) return "/";
  if (index === 2 && /^[A-Za-z]:\//.test(normalized)) {
    return normalized.slice(0, 3);
  }
  return normalized.slice(0, index);
}

/**
 * 右栏钉住的仓库按**工作区根**分开记（环境 + 根路径）：本机的 A 项目钉一个、B 项目钉一个，
 * 某个发行版里的项目各钉一个。原来按空间记，空间就是一个根；删掉空间后只按环境记，
 * 于是同一个环境里换项目（根变了）钉子还钉在老仓库上 —— 右栏继续显示上一个项目的改动与
 * 历史，看起来就是「切到项目却没跟着切」。资源管理器早就按「环境 + 根」分桶
 * （见 `explorer/lib/useFileTree` 的 scopeKey），这里对齐它。
 */
export function repositoryTargetScope(
  workspaceKey: string,
  rootPath: string | null,
): string {
  return `${workspaceKey}\u0000${rootPath ?? ""}`;
}

export function repositoryTargetForWorkspace(
  targets: SourceControlRepositoryTargets,
  workspaceKey: string,
): SourceControlRepositoryTarget {
  const repoRoot = targets[workspaceKey];
  return repoRoot ? { mode: "fixed", repoRoot } : FOLLOW_CONTEXT;
}

export function setRepositoryTargetForWorkspace(
  targets: SourceControlRepositoryTargets,
  workspaceKey: string,
  repoRoot: string,
): SourceControlRepositoryTargets {
  if (targets[workspaceKey] === repoRoot) return targets;
  return { ...targets, [workspaceKey]: repoRoot };
}

export function clearRepositoryTargetForWorkspace(
  targets: SourceControlRepositoryTargets,
  workspaceKey: string,
): SourceControlRepositoryTargets {
  if (!(workspaceKey in targets)) return targets;
  const next = { ...targets };
  delete next[workspaceKey];
  return next;
}

export function activeRepositoryContextPath({
  activeTab,
  activeTerminalLeafCwd,
  explorerRoot,
  workspaceFallbackPath,
}: {
  activeTab: Tab | undefined;
  activeTerminalLeafCwd: string | null;
  explorerRoot: string | null;
  workspaceFallbackPath: string | null;
}): string | null {
  if (activeTab?.kind === "terminal") {
    return activeTerminalLeafCwd ?? explorerRoot ?? workspaceFallbackPath;
  }
  if (activeTab?.kind === "editor") return dirname(activeTab.path);
  if (activeTab?.kind === "git-diff") return activeTab.repoRoot;
  if (activeTab?.kind === "git-commit-file") return activeTab.repoRoot;
  if (activeTab?.kind === "git-history") return activeTab.repoRoot;
  return explorerRoot ?? workspaceFallbackPath;
}

export function sourceControlRepositoryPath({
  contextPath,
  badgeContextPath,
  gitPanelOpen,
  hasOpenGitTab,
  target,
}: {
  contextPath: string | null;
  badgeContextPath: string | null;
  /** 右侧 Git 面板开着的时候，看的就是它自己的仓库。 */
  gitPanelOpen: boolean;
  hasOpenGitTab: boolean;
  target: SourceControlRepositoryTarget;
}): string | null {
  if (gitPanelOpen && target.mode === "fixed") {
    return target.repoRoot;
  }
  return hasOpenGitTab || gitPanelOpen ? contextPath : badgeContextPath;
}

export function gitGraphRepositoryPath({
  contextPath,
  gitPanelOpen,
  target,
}: {
  contextPath: string | null;
  gitPanelOpen: boolean;
  target: SourceControlRepositoryTarget;
}): string | null {
  return gitPanelOpen && target.mode === "fixed"
    ? target.repoRoot
    : contextPath;
}

export function repositoryTargetIsPending({
  target,
  loadedContextPath,
  loadedRepoRoot,
  isLoading,
}: {
  target: SourceControlRepositoryTarget;
  loadedContextPath: string | null;
  loadedRepoRoot: string | null;
  isLoading: boolean;
}): boolean {
  if (target.mode !== "fixed") return false;
  if (loadedContextPath !== target.repoRoot) return true;
  return isLoading && loadedRepoRoot !== target.repoRoot;
}
