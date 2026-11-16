import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The seam between two regions, and who it belongs to.
 *
 * A seam is the gap between two of the three regions: on screen it is three pieces - the separator's
 * width, and a half on the wrapper of either side. Reported as "不是无界时 隐藏两个侧边组件 边缘的间距变宽了
 * 隐藏时把中间组件的间隔也保留了": with a side panel closed its two pieces stayed behind, so the window's
 * margin measured 8px with the panels open and 16px with them closed, and the workspace kept a gap to a
 * region that was not on screen. 无界 hides the same bug, because it takes every seam away at once.
 *
 * The rules are keyed on `data-edge-*`, which `useShellEdges` writes from the layout: "the workspace owns
 * this end of the row" and "the region past this seam is gone" are the same statement. What has to hold is
 * that relationship and not the number, the way the other stylesheet tests here read the sheet as text.
 */
const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

const rules = [
  ...css.replace(/\/\*[\s\S]*?\*\//g, " ").matchAll(/([^{}]+)\{([^}]*)\}/g),
].map((match) => ({
  selector: match[1].trim().replace(/\s+/g, " "),
  body: match[2].trim().replace(/\s+/g, " "),
}));

/** Every rule that answers a closed region: they all ask the workspace where the row now ends. */
const closing = rules.filter(
  (rule) =>
    rule.selector.includes(":has(") &&
    rule.selector.includes('[data-shell="workspace"][data-edge-'),
);

describe("the seam of a closed side panel", () => {
  it("stops the separator taking width", () => {
    const separators = closing.filter((rule) =>
      rule.selector.includes('[data-seam="'),
    );
    const selectors = separators.map((rule) => rule.selector).join(" | ");
    // Both seams, and each one on the separator that belongs to the region that is gone.
    expect(selectors).toContain(
      '[data-shell="workspace"][data-edge-left]) [data-seam="sidebar"]',
    );
    expect(selectors).toContain(
      '[data-shell="workspace"][data-edge-right]) [data-seam="right"]',
    );
    for (const rule of separators) expect(rule.body).toContain("width: 0");
  });

  it("takes the closed region's own half with it", () => {
    // Without this the region's border box is its padding: 0 to the layout, and 4px to a resize observer
    // reading the wrapper - which is how the panel it just closed still counted as open.
    const regions = closing.filter((rule) =>
      /\[data-shell="(?:sidebar|right)"\]/.test(rule.selector),
    );
    expect(regions.length).toBeGreaterThan(0);
    for (const rule of regions) expect(rule.body).toContain("padding-inline: 0");
  });

  it("drops the half the middle region kept toward the closed side", () => {
    const half = (edge: "start" | "end") =>
      closing.find(
        (rule) =>
          rule.selector.includes('[data-shell="workspace"]') &&
          rule.body.includes(`padding-inline-${edge}: 0`),
      );
    // Its own, not the closed region's: the middle region is the one that ends up on the window's edge,
    // and the half it kept is what held it 8px away from it.
    expect(half("start")?.selector).toContain("[data-edge-left]");
    expect(half("start")?.selector).not.toContain("[data-edge-right]");
    expect(half("end")?.selector).toContain("[data-edge-right]");
    expect(half("end")?.selector).not.toContain("[data-edge-left]");
  });

  it("answers the layout, not a stored flag", () => {
    // A flag the panels persist arrives after the slide (measured: the sidebar reached 0px at 330ms and
    // the attribute it wrote arrived at 939ms), so the seam would close behind the animation that closed
    // the region. `data-edge-*` is written where the measurement happens, in the same frame.
    expect(closing.length).toBeGreaterThan(0);
    for (const rule of closing) {
      expect(rule.selector).toMatch(/\[data-edge-(?:left|right)\]/);
      expect(rule.selector).not.toMatch(
        /data-panel-slide|data-(?:sidebar|right)-collapsed|localStorage/,
      );
    }
  });

  it("leaves the seam alone while both regions are there", () => {
    // Every rule is conditional on an edge: with both panels open the stylesheet says nothing about the
    // seams and the widths the components carry stand.
    for (const rule of closing) {
      expect(rule.selector).toMatch(/\[data-edge-(?:left|right)\]/);
    }
  });
});
