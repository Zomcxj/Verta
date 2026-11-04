import { describe, expect, it } from "vitest";
import type { EditorTab, GitHistoryTab, Tab } from "@/modules/tabs";
import {
  activeRepositoryContextPath,
  clearRepositoryTargetForWorkspace,
  gitGraphRepositoryPath,
  repositoryTargetForWorkspace,
  repositoryTargetIsPending,
  repositoryTargetScope,
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
  const rootA = repositoryTargetScope("local", "/projects/a");
  const rootB = repositoryTargetScope("local", "/projects/b");

  it("records a fixed repository for one workspace root only", () => {
    const targets = setRepositoryTargetForWorkspace({}, rootA, "/repos/a");

    expect(repositoryTargetForWorkspace(targets, rootA)).toEqual({
      mode: "fixed",
      repoRoot: "/repos/a",
    });
    expect(repositoryTargetForWorkspace(targets, rootB)).toEqual({
      mode: "follow-context",
    });
    expect(setRepositoryTargetForWorkspace(targets, rootA, "/repos/a")).toBe(
      targets,
    );
  });

  // Two sessions opened at the same folder pin their own sub-repository: a folder that holds
  // several checkouts is where two sessions are most likely to be reading different ones.
  it("keeps two sessions in one folder on their own repositories", () => {
    const first = repositoryTargetScope("local", "/projects/a", 7);
    const second = repositoryTargetScope("local", "/projects/a", 8);
    const pinned = setRepositoryTargetForWorkspace(
      setRepositoryTargetForWorkspace({}, first, "/projects/a/api"),
      second,
      "/projects/a/web",
    );

    expect(first).not.toBe(second);
    expect(repositoryTargetForWorkspace(pinned, first)).toEqual({
      mode: "fixed",
      repoRoot: "/projects/a/api",
    });
    expect(repositoryTargetForWorkspace(pinned, second)).toEqual({
      mode: "fixed",
      repoRoot: "/projects/a/web",
    });
    // A scope still names its environment first, which is what a resolved answer is checked against.
    expect(first.startsWith("local\u0000")).toBe(true);
  });

  it("keeps repository paths isolated by workspace environment", () => {
    const localTargets = setRepositoryTargetForWorkspace(
      {},
      repositoryTargetScope("local", "/projects/a"),
      "C:/repos/a",
    );
    const targets = setRepositoryTargetForWorkspace(
      localTargets,
      repositoryTargetScope("wsl:Ubuntu", "/projects/a"),
      "/repos/a",
    );

    expect(
      repositoryTargetForWorkspace(
        targets,
        repositoryTargetScope("local", "/projects/a"),
      ),
    ).toEqual({ mode: "fixed", repoRoot: "C:/repos/a" });
    expect(
      repositoryTargetForWorkspace(
        targets,
        repositoryTargetScope("wsl:Ubuntu", "/projects/a"),
      ),
    ).toEqual({ mode: "fixed", repoRoot: "/repos/a" });
  });

  // Switching project (same environment, new root) must not keep showing the previous
  // project's repository: back to follow-context, and the right panel shows the new project's own changes and history.
  it("does not carry a pin into another project of the same environment", () => {
    const pinned = setRepositoryTargetForWorkspace({}, rootA, "/repos/a");

    expect(repositoryTargetForWorkspace(pinned, rootB)).toEqual({
      mode: "follow-context",
    });
  });

  it("scopes an empty root apart from a real one", () => {
    expect(repositoryTargetScope("local", null)).not.toBe(rootA);
  });

  it("returns to context-following without changing other roots", () => {
    const other = setRepositoryTargetForWorkspace({}, rootB, "/repos/b");
    const targets = setRepositoryTargetForWorkspace(other, rootA, "/repos/a");
    const next = clearRepositoryTargetForWorkspace(targets, rootA);

    expect(repositoryTargetForWorkspace(next, rootA)).toEqual({
      mode: "follow-context",
    });
    expect(repositoryTargetForWorkspace(next, rootB)).toEqual({
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
