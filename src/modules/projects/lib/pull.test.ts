import { describe, expect, it } from "vitest";

import type { ProjectStatus } from "./types";
import { pullBlocker, upstreamBranchName } from "./pull";

const status = (over: Partial<ProjectStatus> = {}): ProjectStatus => ({
  path: "F:\\work\\Verta",
  name: "Verta",
  workspace: { kind: "local" },
  kind: "repo",
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  detached: false,
  dirty: 0,
  stashed: 0,
  error: null,
  fetchError: null,
  ...over,
});

describe("upstreamBranchName", () => {
  it("去掉远端那一段", () => {
    expect(upstreamBranchName("origin/main")).toBe("main");
    expect(upstreamBranchName("  upstream/main  ")).toBe("main");
  });

  it("分支名里带斜杠时整段还回来", () => {
    // 远端是第一段，后面全是分支名，所以 origin/feature/login 的分支是 feature/login。
    expect(upstreamBranchName("origin/feature/login")).toBe("feature/login");
    expect(upstreamBranchName("origin/origin/main")).toBe("origin/main");
  });

  it("本地分支做上游（没有远端段）与空值", () => {
    expect(upstreamBranchName("main")).toBe("main");
    expect(upstreamBranchName("origin/")).toBeNull();
    expect(upstreamBranchName("   ")).toBeNull();
  });
});

describe("pullBlocker", () => {
  it("同名分支才放行", () => {
    expect(pullBlocker(status({ behind: 3 }))).toBeNull();
    expect(
      pullBlocker(
        status({
          branch: "feature/login",
          upstream: "origin/feature/login",
          behind: 1,
        }),
      ),
    ).toBeNull();
  });

  it("上游分支不同名就拦下，并把两个名字都摆出来", () => {
    const blocker = pullBlocker(status({ branch: "work", upstream: "origin/main" }));
    expect(blocker?.key).toBe("projects.pull.branchDiffers");
    expect(blocker?.params).toMatchObject({
      branch: "work",
      upstream: "origin/main",
      upstreamBranch: "main",
    });
  });

  it("已经是同名分支但没有落后：按钮留着，只说不必拉", () => {
    expect(pullBlocker(status({ behind: 0 }))?.key).toBe("scm.pullUpToDate");
  });

  it("分歧的不在这里合成", () => {
    expect(pullBlocker(status({ ahead: 2, behind: 1 }))?.key).toBe("scm.pullDiverged");
  });

  it("detached、没有上游、没检查过各有各的话", () => {
    expect(pullBlocker(status({ detached: true }))?.key).toBe("projects.pull.detached");
    expect(pullBlocker(status({ upstream: null }))?.key).toBe("scm.pullNoUpstream");
    expect(pullBlocker(status({ branch: "  " }))?.key).toBe("projects.pull.noBranch");
    expect(pullBlocker(status({ upstream: "origin/" }))?.key).toBe(
      "projects.pull.branchUnreadable",
    );
    expect(pullBlocker(null)?.key).toBe("projects.pull.unchecked");
  });

  it("路径没了或不是仓库时照实说", () => {
    expect(pullBlocker(status({ kind: "missing" }))?.key).toBe("projects.state.missing");
    expect(pullBlocker(status({ kind: "notRepo" }))?.key).toBe("projects.state.notRepo");
    expect(pullBlocker(status({ kind: "error" }))?.key).toBe("projects.state.failed");
  });
});