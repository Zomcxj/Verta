import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Where the sheet's outer edge comes from.
 *
 * `shellEdges` is a truth table (see its own test) and the stylesheet decides what an edge is worth;
 * what this reads is the one input the table is fed, because feeding it the wrong thing is what the bug
 * looked like. The corner followed the flag the panels *persist* - written after the resize - so the
 * sheet stayed square against the window for the length of that write: measured on the running app, the
 * sidebar reached 0px at 330ms and the workspace claimed the left edge at 939ms. It has to come from the
 * regions' own widths, and it has to land in the same frame the width changes in.
 */
const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const hook = readFileSync(
  new URL("../hooks/useShellEdges.ts", import.meta.url),
  "utf8",
);

describe("the shell's outer edge", () => {
  it("is marked from the regions' layout, not from the persisted flags", () => {
    expect(hook).toMatch(/getBoundingClientRect\(\)\.width > 0\.5/);
    expect(hook).toMatch(/shellEdges\(\{/);
    // The flags are still what a fresh window starts from - they are just not the answer afterwards.
    expect(app).not.toMatch(/sidebar: !sidebarCollapsed/);
    expect(app).not.toMatch(/right: !rightCollapsed/);
  });

  it("is written where the measurement happens, so the frame that resizes is the frame that is rounded", () => {
    // A React state update is committed after the observer runs, and that gap painted two square frames
    // at 60fps (`requestAnimationFrame` sampling). The observer callback runs after layout and before
    // paint, so an attribute written there is in the same frame.
    expect(hook).toMatch(/new ResizeObserver\(apply\)/);
    expect(hook).toMatch(/toggleAttribute\("data-edge-left"/);
    expect(hook).toMatch(/toggleAttribute\("data-edge-right"/);
    // React must not render these attributes: it would re-declare them from a stale render.
    expect(app).not.toMatch(/data-edge-left=/);
    expect(app).not.toMatch(/data-edge-right=/);
  });

  it("re-attaches when the row itself is replaced", () => {
    // Zen mode unmounts `<main>` and mounts a new one; a hook that ran once would leave the new row
    // unmarked.
    expect(app).toMatch(/useShellEdges\(shellRow\)/);
    expect(app).toMatch(/<main ref=\{setShellRow\}/);
  });
});
