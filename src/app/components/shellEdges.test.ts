import { describe, expect, it } from "vitest";

import { shellEdges } from "./shellEdges";

/**
 * The sheet's outer edge, as a truth table.
 *
 * The failure this guards was a screenshot: with the sidebar collapsed the workspace took the whole
 * row and, being square in the middle of the sheet by design, met the window with a square corner and
 * no margin. The rule is simple enough to state: an edge belongs to the last *visible* region on that
 * side, and the workspace is the answer for either side when the panel beside it is closed.
 */
describe("which region owns the window's edge", () => {
  it("gives each side to the panel that is open", () => {
    expect(shellEdges({ sidebar: true, right: true })).toEqual({
      sidebar: { left: true, right: false },
      workspace: { left: false, right: false },
      right: { left: false, right: true },
    });
  });

  it("hands the left edge to the workspace when the sidebar is collapsed", () => {
    const edges = shellEdges({ sidebar: false, right: true });
    expect(edges.workspace).toEqual({ left: true, right: false });
    expect(edges.sidebar).toEqual({ left: false, right: false });
    expect(edges.right).toEqual({ left: false, right: true });
  });

  it("hands the right edge to the workspace when the right panel is collapsed", () => {
    const edges = shellEdges({ sidebar: true, right: false });
    expect(edges.workspace).toEqual({ left: false, right: true });
    expect(edges.right).toEqual({ left: false, right: false });
  });

  it("gives the workspace both corners when nothing else is open", () => {
    const edges = shellEdges({ sidebar: false, right: false });
    expect(edges.workspace).toEqual({ left: true, right: true });
    expect(edges.sidebar).toEqual({ left: false, right: false });
    expect(edges.right).toEqual({ left: false, right: false });
  });

  it("never gives an edge to a collapsed panel, whatever else is open", () => {
    // A collapsed panel is 0px wide: claiming the edge for it would leave the sheet square against the
    // window, which is the bug.
    for (const right of [true, false]) {
      expect(shellEdges({ sidebar: false, right }).sidebar).toEqual({
        left: false,
        right: false,
      });
    }
    for (const sidebar of [true, false]) {
      expect(shellEdges({ sidebar, right: false }).right).toEqual({
        left: false,
        right: false,
      });
    }
  });
});
