import { describe, expect, it } from "vitest";
import { planRemoteReposOpen, type Tab } from "./useTabs";

function counter(start = 100): () => number {
  let n = start;
  return () => n++;
}

function terminalTab(id: number): Tab {
  return {
    id,
    kind: "terminal",
    title: "shell",
    paneTree: { kind: "leaf", id: id + 1000 },
    activeLeafId: id + 1000,
  };
}

describe("planRemoteReposOpen", () => {
  it("opens one remote repository tab", () => {
    const plan = planRemoteReposOpen([], "远程仓库", counter());
    expect(plan.tabs).toHaveLength(1);
    expect(plan.tabs[0]).toMatchObject({
      kind: "remotes",
      title: "远程仓库",
    });
    expect(plan.targetId).toBe(plan.tabs[0].id);
  });

  it("reuses the tab that is already open", () => {
    const first = planRemoteReposOpen([], "远程仓库", counter());
    const second = planRemoteReposOpen(first.tabs, "远程仓库", counter());
    expect(second.tabs).toBe(first.tabs);
    expect(second.targetId).toBe(first.targetId);
  });

  it("keeps exactly one remotes tab however many terminals are open", () => {
    const tabs = [terminalTab(1), terminalTab(2)];
    const plan = planRemoteReposOpen(tabs, "远程仓库", counter());
    expect(plan.tabs).toHaveLength(3);
    expect(plan.tabs.filter((tab) => tab.kind === "remotes")).toHaveLength(1);
    expect(plan.tabs[2]).toMatchObject({ kind: "remotes" });
  });

  it("refreshes the title when the interface language changed", () => {
    const first = planRemoteReposOpen([], "远程仓库", counter());
    const second = planRemoteReposOpen(
      first.tabs,
      "Remote repositories",
      counter(),
    );
    expect(second.targetId).toBe(first.targetId);
    expect(second.tabs[0].title).toBe("Remote repositories");
  });
});
