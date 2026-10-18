import { describe, expect, it } from "vitest";
import { planProjectsOpen, type Tab } from "./useTabs";

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

describe("planProjectsOpen", () => {
  it("opens one projects tab per space", () => {
    const plan = planProjectsOpen([], "s1", "项目", counter());
    expect(plan.tabs).toHaveLength(1);
    expect(plan.tabs[0]).toMatchObject({
      kind: "projects",
      spaceId: "s1",
      title: "项目",
    });
    expect(plan.targetId).toBe(plan.tabs[0].id);
  });

  it("reuses the tab that is already open in that space", () => {
    const first = planProjectsOpen([], "s1", "项目", counter());
    const second = planProjectsOpen(first.tabs, "s1", "项目", counter());
    expect(second.tabs).toBe(first.tabs);
    expect(second.targetId).toBe(first.targetId);
  });

  it("keeps a separate tab for another space", () => {
    const tabs = [terminalTab(1, "s1"), terminalTab(2, "s2")];
    const plan = planProjectsOpen(tabs, "s2", "项目", counter());
    expect(plan.tabs).toHaveLength(3);
    expect(
      plan.tabs.filter((tab) => tab.kind === "projects"),
    ).toHaveLength(1);
    expect(plan.tabs[2]).toMatchObject({ kind: "projects", spaceId: "s2" });
  });

  it("refreshes the title when the interface language changed", () => {
    const first = planProjectsOpen([], "s1", "项目", counter());
    const second = planProjectsOpen(first.tabs, "s1", "Projects", counter());
    expect(second.targetId).toBe(first.targetId);
    expect(second.tabs[0].title).toBe("Projects");
  });
});