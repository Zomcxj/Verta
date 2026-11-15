import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveShape } from "../modules/theme/shape";

/**
 * The two shapes that were reported as not doing what their names say.
 *
 * 无界 merges the three regions into one sheet, and it did that so well that a drag gave no sign of where
 * it was happening: the handle between two regions is `width: 0` for this shape, so the line it paints -
 * which is the only thing it paints - had nothing to paint on. 浮雕 drew one 1px highlight and one 1px
 * shadow, which on a dark theme is indistinguishable from 极简 (no border, no bevel, nothing), so the
 * preset read as a rounding error rather than as a material.
 *
 * Read as text, the way the other stylesheet tests here do: this repository renders no components, and
 * what has to hold is the relationship between the rule and the state it answers, not the paint itself.
 */
const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

/** Every top-level rule in the sheet, comments stripped, with its body. */
const rules = [
  ...css.replace(/\/\*[\s\S]*?\*\//g, " ").matchAll(/([^{}]+)\{([^}]*)\}/g),
].map((match) => ({
  selector: match[1].trim().replace(/\s+/g, " "),
  body: match[2].trim(),
}));

const ruleWith = (selector: string) =>
  rules.find((rule) => rule.selector === selector);

describe("无界's seam, while it is being dragged", () => {
  // The merged sheet is its own axis (`data-boundless`), not a shape: it combines with every preset.
  const handle = 'html[data-boundless] [data-slot="resizable-handle"]';

  it("keeps the seam invisible at rest", () => {
    // The sheet has no seams at rest: that is the whole of the axis. It must not be widened to draw the line.
    expect(ruleWith(handle)?.body).toContain("width: 0");
  });

  it("draws a 1px stripe on the hit area the handle already has", () => {
    const stripe = ruleWith(`${handle}::after`);
    expect(stripe, "a 0px handle paints nothing, so the drag is invisible").toBeDefined();
    // The handle's ::after is the 16px overlay that keeps a zero-width handle draggable; the stripe
    // goes down the middle of it, so what appears is a line and not a band.
    expect(stripe?.body).toMatch(/linear-gradient\(\s*to right/);
    expect(stripe?.body).toMatch(/calc\(50% - 0\.5px\)/);
    expect(stripe?.body).toMatch(/calc\(50% \+ 0\.5px\)/);
    // Hidden until something asks for it, or the shape would have seams again.
    expect(stripe?.body).toMatch(/opacity: 0/);
  });

  it("shows it on hover and for the whole drag", () => {
    const shown = rules.filter(
      (rule) => rule.selector.includes("resizable-handle") && /opacity: 1/.test(rule.body),
    );
    const selector = shown.map((rule) => rule.selector).join(" | ");
    // Hover is the hint that there is something to grab; `:active` covers a drag the pointer started and
    // `data-separator="active"` is the state the library itself reports, which outlives a lost pointer.
    expect(selector).toContain(":hover");
    expect(selector).toContain(":active");
    expect(selector).toContain('[data-separator="active"]');
  });

  it("turns the stripe for a stacked pair", () => {
    const horizontal = rules.find(
      (rule) =>
        rule.selector.includes("resizable-handle") &&
        rule.selector.includes('[aria-orientation="horizontal"]'),
    );
    expect(horizontal?.body).toMatch(/to bottom/);
  });
});

describe("浮雕's plate", () => {
  const plate = resolveShape("emboss").vars;

  it("lights one side and shades the other, so it has a direction", () => {
    // A single line each way is a hairline; a light has a side.
    expect(plate["--bevel-top"]).toMatch(/inset 1px 0/);
    expect(plate["--bevel-bottom"]).toMatch(/inset -1px 0/);
  });

  it("gives the bottom edge thickness", () => {
    // The dark band above the 1px edge is what says the pane is a plate rather than a rectangle with a
    // line drawn round it.
    expect(plate["--bevel-bottom"]).toMatch(/inset 0 -2px/);
  });

  it("is not 极简 with another name", () => {
    const emboss = resolveShape("emboss");
    const minimal = resolveShape("minimal");
    expect(emboss.vars["--pane-border-width"]).not.toBe(minimal.vars["--pane-border-width"]);
    expect(emboss.vars["--bevel-top"]).not.toBe(minimal.vars["--bevel-top"]);
  });

  it("is its edge and nothing else", () => {
    const rule = ruleWith('html[data-shape="emboss"] .verta-pane');
    // No gradient of its own: a lighter band behind the interface is a backdrop, and it is also what
    // made the plate read as a card inside the sheet.
    expect(rule?.body).not.toMatch(/background/);
    expect(rule?.body).toContain("box-shadow: var(--bevel-top), var(--bevel-bottom)");
    // Painted, not composited: no blur, no filter, no backdrop (`compositingBudget.test.ts`).
    expect(rule?.body).not.toMatch(/blur|backdrop/);
    expect(rule?.body).not.toMatch(/(?<![-\w])filter:/);
  });
});
