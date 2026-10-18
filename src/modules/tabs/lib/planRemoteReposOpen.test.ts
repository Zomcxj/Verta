import { describe, expect, it } from "vitest";
import { planRemoteReposOpen, type Tab } from "./useTabs";

function counter(start = 100): () => number {
  let n = start;
  return () => n++;
}

function terminalTab(id: number, spaceId = "s1"): Tab {
  return {
    id,
    kind: "terminal",
    spaceId,
    title: "shell",
    paneTree: { kind: "leaf", id: id + 1000 },
    activeLeafId: id + 1000,
  } as Tab;
}

describe("planRemoteReposOpen", () => {
  it("opens one remote repository tab per space", () => {
    const plan = planRemoteReposOpen([], "s1", "远程仓库", counter());
    expect(plan.tabs).toHaveLength(1);
    expect(plan.tabs[0]).toMatchObject({
      kind: "remotes",
      spaceId: "s1",
      title: "远程仓库",
    });
    expect(plan.targetId).toBe(plan.tabs[0].id);
  });

  it("reuses the tab that is already open in that space", () => {
    const first = planRemoteReposOpen([], "s1", "远程仓库", counter());
    const second = planRemoteReposOpen(
      first.tabs,
      "s1",
      "远程仓库",
      counter(),
    );
    expect(second.tabs).toBe(first.tabs);
    expect(second.targetId).toBe(first.targetId);
  });

  it("keeps a separate tab for another space", () => {
    const tabs = [terminalTab(1, "s1"), terminalTab(2, "s2")];
    const plan = planRemoteReposOpen(tabs, "s2", "远程仓库", counter());
    expect(plan.tabs).toHaveLength(3);
    expect(plan.tabs.filter((tab) => tab.kind === "remotes")).toHaveLength(1);
    expect(plan.tabs[2]).toMatchObject({ kind: "remotes", spaceId: "s2" });
  });

  it("refreshes the title when the interface language changed", () => {
    const first = planRemoteReposOpen([], "s1", "远程仓库", counter());
    const second = planRemoteReposOpen(
      first.tabs,
      "s1",
      "Remote repositories",
      counter(),
    );
    expect(second.targetId).toBe(first.targetId);
    expect(second.tabs[0].title).toBe("Remote repositories");
  });
});