import { describe, expect, it } from "vitest";
import type { Tab } from "@/modules/tabs";
import { sessionOpeningVisible } from "./sessionOpening";

function terminal(id: number, leafId: number): Tab {
  return {
    id,
    kind: "terminal",
    title: "shell",
    paneTree: { kind: "leaf", id: leafId },
    activeLeafId: leafId,
  };
}

/** A tab split in two, to check that a sibling pane shares the tab's layer. */
function split(id: number, left: number, right: number): Tab {
  return {
    id,
    kind: "terminal",
    title: "shell",
    paneTree: {
      kind: "split",
      id: id * 100,
      dir: "row",
      children: [
        { kind: "leaf", id: left },
        { kind: "leaf", id: right },
      ],
    },
    activeLeafId: left,
  };
}

function editor(id: number): Tab {
  return {
    id,
    kind: "editor",
    title: `file-${id}`,
    path: `/file-${id}`,
    dirty: false,
    preview: false,
  };
}

describe("sessionOpeningVisible", () => {
  it("只有开在某个标签里、且那个标签正被看着时才显示", () => {
    expect(sessionOpeningVisible([terminal(1, 10)], 1, 10)).toBe(true);
  });

  it("标签被关掉之后就不再显示（点开会话又立刻关掉的那一下）", () => {
    expect(sessionOpeningVisible([terminal(2, 20)], 2, 10)).toBe(false);
    expect(sessionOpeningVisible([], 1, 10)).toBe(false);
  });

  it("切到别的标签就不再显示，别挡着别人的终端", () => {
    const tabs = [terminal(1, 10), terminal(2, 20)];
    expect(sessionOpeningVisible(tabs, 2, 10)).toBe(false);
    // Switching to a non-terminal tab is not visible either.
    expect(sessionOpeningVisible([...tabs, editor(3)], 3, 10)).toBe(false);
  });

  it("同一个标签的另一半窗格共用这一层", () => {
    expect(sessionOpeningVisible([split(1, 10, 11)], 1, 11)).toBe(true);
  });

  it("没有在开会话时什么都不显示", () => {
    expect(sessionOpeningVisible([terminal(1, 10)], 1, null)).toBe(false);
  });
});