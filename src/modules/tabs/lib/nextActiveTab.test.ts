import { describe, expect, it } from "vitest";
import { nextActiveTab, type Tab } from "./useTabs";

function term(id: number): Tab {
  return {
    id,
    kind: "terminal",
    title: "shell",
    paneTree: { kind: "leaf", id: id * 10 },
    activeLeafId: id * 10,
  };
}

describe("nextActiveTab", () => {
  it("picks the tab before the closing one", () => {
    const tabs = [term(1), term(2), term(3)];
    expect(nextActiveTab(tabs, 3)).toBe(2);
    expect(nextActiveTab(tabs, 2)).toBe(1);
  });

  it("falls forward when closing the first tab", () => {
    expect(nextActiveTab([term(1), term(2)], 1)).toBe(2);
  });

  it("takes the next tab when the closing one is not at an edge", () => {
    const tabs = [term(1), term(2), term(3)];
    expect(nextActiveTab(tabs, 3)).toBe(2);
  });

  it("returns null for the last remaining tab (refuse to close)", () => {
    expect(nextActiveTab([term(1)], 1)).toBeNull();
  });

  it("returns null for an unknown id", () => {
    expect(nextActiveTab([term(1), term(2)], 99)).toBeNull();
  });
});
