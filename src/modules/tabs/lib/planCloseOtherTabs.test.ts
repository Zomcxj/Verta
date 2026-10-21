import { describe, expect, it } from "vitest";
import { planCloseOtherTabs, type Tab } from "./useTabs";

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

describe("planCloseOtherTabs", () => {
  it("collects every other tab", () => {
    const tabs = [tab(1), tab(2), tab(3)];
    expect(planCloseOtherTabs(tabs, 2, 2)).toEqual({
      closeIds: [1, 3],
      nextActiveId: 2,
    });
  });

  it("returns nothing when the anchor is the only tab", () => {
    const tabs = [tab(1)];
    expect(planCloseOtherTabs(tabs, 1, 1)).toEqual({
      closeIds: [],
      nextActiveId: 1,
    });
  });

  it("falls back to the anchor when the active tab is being closed", () => {
    const tabs = [tab(1), tab(2), tab(3)];
    expect(planCloseOtherTabs(tabs, 1, 3)).toEqual({
      closeIds: [2, 3],
      nextActiveId: 1,
    });
  });

  it("keeps the anchor active when it is not among the closed", () => {
    const tabs = [tab(1), tab(2), tab(3)];
    expect(planCloseOtherTabs(tabs, 3, 3)).toEqual({
      closeIds: [1, 2],
      nextActiveId: 3,
    });
  });

  it("returns nothing for an unknown anchor", () => {
    const tabs = [tab(1)];
    expect(planCloseOtherTabs(tabs, 99, 1)).toEqual({
      closeIds: [],
      nextActiveId: 1,
    });
  });
});
