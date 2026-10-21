import { describe, expect, it } from "vitest";
import type { EditorTab, GitHistoryTab, Tab } from "@/modules/tabs";
import {
  activeRepositoryContextPath,
  clearRepositoryTargetForWorkspace,
  gitGraphRepositoryPath,
  repositoryTargetForWorkspace,
  repositoryTargetIsPending,
  setRepositoryTargetForWorkspace,
  sourceControlRepositoryPath,
} from "./repositoryTarget";

const terminalTab: Tab = {
  id: 1,
  kind: "terminal",
  title: "shell",
  paneTree: { kind: "leaf", id: 10 },
  activeLeafId: 10,
};

const editorTab: EditorTab = {
  id: 2,
  kind: "editor",
  title: "main.ts",
  path: "C:\\repo\\src\\main.ts",
  dirty: false,
  preview: false,
};

const historyTab: GitHistoryTab = {
  id: 3,
  kind: "git-history",
  title: "History",
  repoRoot: "/repos/history",
};

describe("repository targets", () => {
  it("records a fixed repository for one environment only", () => {
    const targets = setRepositoryTargetForWorkspace({}, "local", "/repos/a");

    expect(repositoryTargetForWorkspace(targets, "local")).toEqual({
      mode: "fixed",
      repoRoot: "/repos/a",
    });
    expect(repositoryTargetForWorkspace(targets, "wsl:Ubuntu")).toEqual({
      mode: "follow-context",
    });
    expect(setRepositoryTargetForWorkspace(targets, "local", "/repos/a")).toBe(
      targets,
    );
  });

  it("keeps repository paths isolated by workspace environment", () => {
    const localTargets = setRepositoryTargetForWorkspace(
      {},
      "local",
      "C:/repos/a",
    );
    const targets = setRepositoryTargetForWorkspace(
      localTargets,
      "wsl:Ubuntu",
      "/repos/a",
    );

    expect(repositoryTargetForWorkspace(targets, "local")).toEqual({
      mode: "fixed",
      repoRoot: "C:/repos/a",
    });
    expect(repositoryTargetForWorkspace(targets, "wsl:Ubuntu")).toEqual({
      mode: "fixed",
      repoRoot: "/repos/a",
    });
  });

  it("returns to context-following without changing other environments", () => {
    const otherEnv = setRepositoryTargetForWorkspace(
      {},
      "wsl:Ubuntu",
      "/repos/b",
    );
    const targets = setRepositoryTargetForWorkspace(
      otherEnv,
      "local",
      "/repos/a",
    );
    const next = clearRepositoryTargetForWorkspace(targets, "local");

    expect(repositoryTargetForWorkspace(next, "local")).toEqual({
      mode: "follow-context",
    });
    expect(repositoryTargetForWorkspace(next, "wsl:Ubuntu")).toEqual({
      mode: "fixed",
      repoRoot: "/repos/b",
    });
  });
});

describe("activeRepositoryContextPath", () => {
  it("prefers the focused terminal leaf cwd", () => {
    expect(
      activeRepositoryContextPath({
        activeTab: terminalTab,
        activeTerminalLeafCwd: "/repos/terminal/packages/app",
        explorerRoot: "/repos/explorer",
        workspaceFallbackPath: "/fallback",
      }),
    ).toBe("/repos/terminal/packages/app");
  });

  it("uses the editor parent directory across Windows paths", () => {
    expect(
      activeRepositoryContextPath({
        activeTab: editorTab,
        activeTerminalLeafCwd: null,
        explorerRoot: "/repos/explorer",
        workspaceFallbackPath: "/fallback",
      }),
    ).toBe("C:/repo/src");
  });

  it("preserves Unix and Windows filesystem roots", () => {
    expect(
      activeRepositoryContextPath({
        activeTab: { ...editorTab, path: "/main.ts" },
        activeTerminalLeafCwd: null,
        explorerRoot: null,
        workspaceFallbackPath: null,
      }),
    ).toBe("/");
    expect(
      activeRepositoryContextPath({
        activeTab: { ...editorTab, path: "C:\\main.ts" },
        activeTerminalLeafCwd: null,
        explorerRoot: null,
        workspaceFallbackPath: null,
      }),
    ).toBe("C:/");
  });

  it("keeps a Git tab bound to its own repository", () => {
    expect(
      activeRepositoryContextPath({
        activeTab: historyTab,
        activeTerminalLeafCwd: null,
        explorerRoot: "/repos/explorer",
        workspaceFallbackPath: "/fallback",
      }),
    ).toBe("/repos/history");
  });
});

describe("sourceControlRepositoryPath", () => {
  const fixed = { mode: "fixed", repoRoot: "/repos/fixed" } as const;

  it("applies a fixed target inside Source Control", () => {
    expect(
      sourceControlRepositoryPath({
        contextPath: "/repos/active",
        badgeContextPath: "/repos/explorer",
        gitPanelOpen: true,
        hasOpenGitTab: false,
        target: fixed,
      }),
    ).toBe("/repos/fixed");
  });

  it("does not leak a fixed target into Explorer decorations or badges", () => {
    expect(
      sourceControlRepositoryPath({
        contextPath: "/repos/active",
        badgeContextPath: "/repos/explorer",
        gitPanelOpen: false,
        hasOpenGitTab: false,
        target: fixed,
      }),
    ).toBe("/repos/explorer");
  });

  it("keeps open Git tabs on their active repository outside Source Control", () => {
    expect(
      sourceControlRepositoryPath({
        contextPath: "/repos/history",
        badgeContextPath: "/repos/explorer",
        gitPanelOpen: false,
        hasOpenGitTab: true,
        target: fixed,
      }),
    ).toBe("/repos/history");
  });

  it("uses the fixed target for graph routing only from Source Control", () => {
    expect(
      gitGraphRepositoryPath({
        contextPath: "/repos/active",
        gitPanelOpen: true,
        target: fixed,
      }),
    ).toBe("/repos/fixed");
    expect(
      gitGraphRepositoryPath({
        contextPath: "/repos/active",
        gitPanelOpen: false,
        target: fixed,
      }),
    ).toBe("/repos/active");
  });
});

describe("repositoryTargetIsPending", () => {
  const fixed = { mode: "fixed", repoRoot: "/repos/fixed" } as const;

  it("masks state loaded for a previous repository", () => {
    expect(
      repositoryTargetIsPending({
        target: fixed,
        loadedContextPath: "/repos/previous",
        loadedRepoRoot: "/repos/previous",
        isLoading: false,
      }),
    ).toBe(true);
  });

  it("keeps loading masked until the selected repository is loaded", () => {
    expect(
      repositoryTargetIsPending({
        target: fixed,
        loadedContextPath: "/repos/fixed",
        loadedRepoRoot: null,
        isLoading: true,
      }),
    ).toBe(true);
  });

  it("reveals a completed error or no-repository state", () => {
    expect(
      repositoryTargetIsPending({
        target: fixed,
        loadedContextPath: "/repos/fixed",
        loadedRepoRoot: null,
        isLoading: false,
      }),
    ).toBe(false);
  });
});
