import { describe, expect, it } from "vitest";
import { planNotesTabOpen, type Tab } from "./useTabs";

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

describe("planNotesTabOpen", () => {
  it("opens one notes tab with nothing picked", () => {
    const plan = planNotesTabOpen([], "笔记", "C:/app/notes", counter());
    expect(plan.tabs).toHaveLength(1);
    expect(plan.tabs[0]).toMatchObject({
      kind: "notes",
      title: "笔记",
      root: "C:/app/notes",
      activePath: null,
    });
    expect(plan.targetId).toBe(plan.tabs[0].id);
  });

  it("reuses the tab that is already open", () => {
    const first = planNotesTabOpen([], "笔记", "C:/app/notes", counter());
    const second = planNotesTabOpen(first.tabs, "笔记", "C:/app/notes", counter());
    expect(second.tabs).toBe(first.tabs);
    expect(second.targetId).toBe(first.targetId);
  });

  it("keeps exactly one notes tab however many terminals are open", () => {
    const tabs = [terminalTab(1), terminalTab(2)];
    const plan = planNotesTabOpen(tabs, "笔记", "C:/app/notes", counter());
    expect(plan.tabs).toHaveLength(3);
    expect(plan.tabs.filter((tab) => tab.kind === "notes")).toHaveLength(1);
    expect(plan.tabs[2]).toMatchObject({ kind: "notes" });
  });

  it("adopts a folder that moved with the executable, and drops the pick with it", () => {
    const first = planNotesTabOpen([], "笔记", "C:/old/notes", counter());
    const second = planNotesTabOpen(
      first.tabs,
      "笔记",
      "C:/new/notes",
      counter(),
    );
    expect(second.targetId).toBe(first.targetId);
    const tab = second.tabs[0];
    if (tab.kind !== "notes") throw new Error("not notes");
    expect(tab.root).toBe("C:/new/notes");
    // The note picked in the old folder is not a file of the new one.
    expect(tab.activePath).toBeNull();
  });
});
