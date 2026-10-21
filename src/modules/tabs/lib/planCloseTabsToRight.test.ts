import { describe, expect, it } from "vitest";
import { planCloseTabsToRight, type Tab } from "./useTabs";

function tab(id: number, kind: Tab["kind"] = "editor"): Tab {
  return {
    id,
    kind,
    title: `tab-${id}`,
    path: `/file-${id}`,
    dirty: false,
    preview: false,
  } as Tab;
}

describe("planCloseTabsToRight", () => {
  it("collects the tabs strictly to the right", () => {
    const tabs = [tab(1), tab(2), tab(3)];
    expect(planCloseTabsToRight(tabs, 1, 1)).toEqual({
      closeIds: [2, 3],
      nextActiveId: 1,
    });
  });

  it("returns nothing when the anchor is the last tab", () => {
    const tabs = [tab(1), tab(2)];
    expect(planCloseTabsToRight(tabs, 2, 1)).toEqual({
      closeIds: [],
      nextActiveId: 1,
    });
  });

  it("falls back to the anchor when the active tab is being closed", () => {
    const tabs = [tab(1), tab(2), tab(3)];
    expect(planCloseTabsToRight(tabs, 1, 3)).toEqual({
      closeIds: [2, 3],
      nextActiveId: 1,
    });
  });

  it("keeps the active tab when it is not among the closed", () => {
    const tabs = [tab(1), tab(2), tab(3)];
    expect(planCloseTabsToRight(tabs, 2, 1)).toEqual({
      closeIds: [3],
      nextActiveId: 1,
    });
  });

  it("returns nothing for an unknown anchor", () => {
    const tabs = [tab(1)];
    expect(planCloseTabsToRight(tabs, 99, 1)).toEqual({
      closeIds: [],
      nextActiveId: 1,
    });
  });
});
