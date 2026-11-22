import { describe, expect, it } from "vitest";
import type { Tab } from "@/modules/tabs";
import {
  addSessionOpening,
  dropSessionOpening,
  sessionOpeningAlive,
  sessionOpeningFor,
  sessionOpeningVisible,
} from "./sessionOpening";

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
describe("sessionOpeningAlive", () => {
  it("会话还在某个标签里就还活着，哪怕那个标签不是当前看的", () => {
    // 切换标签只应该把这一层藏起来，不应该结束它：会话还在启动，回来后要看到的仍然是那段过渡，
    // 而不是它本来要藏起来的那条启动命令行（"加载动画一切标签就没了"）。
    const tabs = [terminal(1, 10), terminal(2, 20)];
    expect(sessionOpeningAlive(tabs, 10)).toBe(true);
    expect(sessionOpeningAlive(tabs, 20)).toBe(true);
  });

  it("标签被关掉之后才算结束", () => {
    expect(sessionOpeningAlive([terminal(2, 20)], 10)).toBe(false);
    expect(sessionOpeningAlive([], 10)).toBe(false);
  });

  it("同一个标签的另一半窗格也算还在", () => {
    expect(sessionOpeningAlive([split(1, 10, 11)], 11)).toBe(true);
  });

  it("编辑器标签不携带终端 leaf", () => {
    expect(sessionOpeningAlive([terminal(1, 10), editor(3)], 10)).toBe(true);
    expect(sessionOpeningAlive([editor(3)], 10)).toBe(false);
  });

  it("没有在开会话时什么都不算", () => {
    expect(sessionOpeningAlive([terminal(1, 10)], null)).toBe(false);
  });
});

describe("more than one session starting at once", () => {
  it("keeps every start, not only the newest", () => {
    // Reported as "连续点击多个会话，只有最后一个切标签切回加载动画还在，其它的都变成了终端指令".
    // The layer used to be one piece of state, so opening B replaced A's entry: A's pane was uncovered
    // and its own screen - which already held the resume command - showed.
    const starts = addSessionOpening(addSessionOpening([], 10, "claude", 1), 11, "opencode", 2);
    expect(starts.map((s) => s.leafId)).toEqual([10, 11]);
    expect(sessionOpeningFor(starts, 10)?.tool).toBe("claude");
    expect(sessionOpeningFor(starts, 11)?.tool).toBe("opencode");
  });

  it("draws the layer for whichever of them is the tab on screen", () => {
    // One layer, because there is one tab on screen; which start it belongs to follows the reader.
    const starts = addSessionOpening(addSessionOpening([], 10, "claude", 1), 11, "opencode", 2);
    const tabs = [terminal(1, 10), terminal(2, 11)];
    expect(sessionOpeningFor(starts, 10)?.tool).toBe("claude");
    expect(sessionOpeningVisible(tabs, 1, 10)).toBe(true);
    expect(sessionOpeningVisible(tabs, 2, 11)).toBe(true);
    // A tab with no start of its own draws nothing.
    expect(sessionOpeningVisible(tabs, 3, null)).toBe(false);
  });

  it("drops one start without touching the others", () => {
    const starts = addSessionOpening(addSessionOpening([], 10, "claude", 1), 11, "opencode", 2);
    const after = dropSessionOpening(starts, 10);
    expect(after.map((s) => s.leafId)).toEqual([11]);
    expect(sessionOpeningFor(after, 10)).toBeNull();
    expect(sessionOpeningFor(after, 11)?.tool).toBe("opencode");
  });

  it("starts the same leaf once, whatever is asked twice", () => {
    const starts = addSessionOpening(addSessionOpening([], 10, "claude", 1), 10, "claude", 2);
    expect(starts).toHaveLength(1);
  });
});
