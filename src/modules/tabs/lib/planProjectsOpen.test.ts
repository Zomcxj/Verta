import { describe, expect, it } from "vitest";
import { planProjectsOpen, type Tab } from "./useTabs";

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

describe("planProjectsOpen", () => {
  it("opens one projects tab", () => {
    const plan = planProjectsOpen([], "项目", counter());
    expect(plan.tabs).toHaveLength(1);
    expect(plan.tabs[0]).toMatchObject({
      kind: "projects",
      title: "项目",
    });
    expect(plan.targetId).toBe(plan.tabs[0].id);
  });

  it("reuses the tab that is already open", () => {
    const first = planProjectsOpen([], "项目", counter());
    const second = planProjectsOpen(first.tabs, "项目", counter());
    expect(second.tabs).toBe(first.tabs);
    expect(second.targetId).toBe(first.targetId);
  });

  it("keeps exactly one projects tab however many terminals are open", () => {
    const tabs = [terminalTab(1), terminalTab(2)];
    const plan = planProjectsOpen(tabs, "项目", counter());
    expect(plan.tabs).toHaveLength(3);
    expect(plan.tabs.filter((tab) => tab.kind === "projects")).toHaveLength(1);
    expect(plan.tabs[2]).toMatchObject({ kind: "projects" });
  });

  it("refreshes the title when the interface language changed", () => {
    const first = planProjectsOpen([], "项目", counter());
    const second = planProjectsOpen(first.tabs, "Projects", counter());
    expect(second.targetId).toBe(first.targetId);
    expect(second.tabs[0].title).toBe("Projects");
  });
});
