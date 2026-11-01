import { beforeEach, describe, expect, it } from "vitest";
import type { GitRepoInfo, GitStatusSnapshot } from "@/lib/native";
import {
  clearRepoSnapshots,
  getRepoSnapshot,
  isSnapshotFresh,
  rememberRepoSnapshot,
  REPO_SNAPSHOT_TTL_MS,
  type RepoSnapshot,
  repoSnapshotKey,
} from "./repoSnapshots";

const repo = (root: string): GitRepoInfo => ({
  repoRoot: root,
  branch: "main",
  upstream: "origin/main",
  isDetached: false,
});

const snapshotAt = (root: string, at: number): RepoSnapshot => ({
  repo: repo(root),
  status: null as GitStatusSnapshot | null,
  at,
});

describe("repoSnapshotKey", () => {
  it("identifies a repository by its root, not by how it was spelled", () => {
    // Two sessions in different subdirectories of one repository must share its status.
    expect(repoSnapshotKey("F:\\VibeCoding_workspace\\Verta", "local")).toBe(
      repoSnapshotKey("F:/VibeCoding_workspace/Verta/", "local"),
    );
  });

  it("does not fold the case of a POSIX path", () => {
    // `/repo` and `/Repo` are different directories on Linux and macOS.
    expect(repoSnapshotKey("/repo", "local")).not.toBe(
      repoSnapshotKey("/Repo", "local"),
    );
  });

  it("folds the case of a Windows drive path", () => {
    expect(repoSnapshotKey("C:\\Repo", "local")).toBe(
      repoSnapshotKey("c:/repo", "local"),
    );
  });

  it("keeps two workspaces apart", () => {
    // The same sensible-looking root in two WSL distros is two repositories.
    expect(repoSnapshotKey("/repo", "wsl:Ubuntu")).not.toBe(
      repoSnapshotKey("/repo", "wsl:Debian"),
    );
  });
});

describe("rememberRepoSnapshot and getRepoSnapshot", () => {
  beforeEach(() => clearRepoSnapshots());

  it("hands back what was remembered", () => {
    const key = repoSnapshotKey("F:/repo", "local");
    rememberRepoSnapshot(key, snapshotAt("F:/repo", 1_000));
    expect(getRepoSnapshot(key)?.repo.repoRoot).toBe("F:/repo");
  });

  it("says nothing about a repository it has never seen", () => {
    expect(getRepoSnapshot(repoSnapshotKey("F:/never", "local"))).toBeUndefined();
  });

  it("replaces an older snapshot of the same repository", () => {
    const key = repoSnapshotKey("F:/repo", "local");
    rememberRepoSnapshot(key, snapshotAt("F:/repo", 1_000));
    rememberRepoSnapshot(key, snapshotAt("F:/repo", 9_000));
    expect(getRepoSnapshot(key)?.at).toBe(9_000);
  });

  it("drops the least recently used repository, not the oldest read", () => {
    const limit = 12;
    const keys = Array.from({ length: limit }, (_, index) =>
      repoSnapshotKey(`F:/r${index}`, "local"),
    );
    keys.forEach((key, index) => {
      rememberRepoSnapshot(key, snapshotAt(`F:/r${index}`, index));
    });
    // Touching r0 makes r1 the least recently used, so r1 is the one the next insert must evict.
    expect(getRepoSnapshot(keys[0])).toBeDefined();
    rememberRepoSnapshot(
      repoSnapshotKey("F:/r12", "local"),
      snapshotAt("F:/r12", limit),
    );
    expect(getRepoSnapshot(keys[0])).toBeDefined();
    expect(getRepoSnapshot(keys[1])).toBeUndefined();
  });
});

describe("isSnapshotFresh", () => {
  it("is fresh inside the window and stale past it", () => {
    const snapshot = snapshotAt("F:/repo", 1_000);
    expect(isSnapshotFresh(snapshot, 1_000 + REPO_SNAPSHOT_TTL_MS - 1)).toBe(true);
    expect(isSnapshotFresh(snapshot, 1_000 + REPO_SNAPSHOT_TTL_MS)).toBe(false);
  });
});
