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
 * The repo pinned in the right panel is remembered per **session tab** within a workspace root
 * (env + root path + tab): project A and project B locally each pin their own, each project inside
 * a distro pins its own, and two sessions opened at the *same* folder pin independently - a folder
 * that holds several checkouts is exactly where two sessions are likely to be looking at different
 * ones, and the pin used to be shared, so switching the sub-repository in one session switched it in
 * the other ("两个会话在同一个目录，各自切换展示的子仓库不同步").
 *
 * It used to be per workspace, and a workspace is a single root; after workspaces were removed it was
 * per env only, so switching projects within one env (root changed) left the pin on the old repo.
 * The explorer has long bucketed by "env + root" (see `scopeKey` in `explorer/lib/useFileTree`); this
 * aligns with it and adds the tab.
 *
 * The tab is appended, not inserted: every reader that asks "is this scope still in the same
 * environment" (`isRepositoryContextCurrent`) matches on the prefix the first two parts form.
 */
export function repositoryTargetScope(
  workspaceKey: string,
  rootPath: string | null,
  tabId?: number | null,
): string {
  return `${workspaceKey}\u0000${rootPath ?? ""}\u0000tab:${tabId ?? ""}`;
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
  /** While the right-side Git panel is open it looks at its own repo. */
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
