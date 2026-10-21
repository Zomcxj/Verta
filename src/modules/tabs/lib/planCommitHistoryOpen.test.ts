import { describe, expect, it } from "vitest";
import { planCommitHistoryOpen, type GitHistoryTab } from "./useTabs";

function history(id: number, repoRoot: string): GitHistoryTab {
  return {
    id,
    kind: "git-history",
    title: "Git History",
    repoRoot,
  };
}

describe("planCommitHistoryOpen", () => {
  it("reuses the history tab of the same repository", () => {
    const existing = history(1, "/repos/a");
    let allocations = 0;
    const result = planCommitHistoryOpen(
      [existing],
      { repoRoot: "/repos/a", branch: "main" },
      () => {
        allocations += 1;
        return 2;
      },
    );

    expect(result.targetId).toBe(1);
    expect(result.tabs[0]).toMatchObject({ title: "History · main" });
    expect(allocations).toBe(0);

    const repeated = planCommitHistoryOpen(
      result.tabs,
      { repoRoot: "/repos/a", branch: "main" },
      () => 2,
    );
    expect(repeated.tabs).toBe(result.tabs);
  });

  it("opens separate tabs for separate repositories", () => {
    const existing = history(1, "/repos/a");
    const result = planCommitHistoryOpen(
      [existing],
      { repoRoot: "/repos/b", branch: "feature" },
      () => 2,
    );

    expect(result.targetId).toBe(2);
    expect(result.tabs).toEqual([
      existing,
      expect.objectContaining({
        id: 2,
        repoRoot: "/repos/b",
        title: "History · feature",
      }),
    ]);
  });

  it("keeps the repository name when no branch is known", () => {
    const result = planCommitHistoryOpen([], { repoRoot: "/repos/a" }, () => 2);

    expect(result.targetId).toBe(2);
    expect(result.tabs[0]).toMatchObject({ title: "Git History" });
  });
});
