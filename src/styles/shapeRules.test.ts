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

  it("keeps 石板's outline on the sheet's own edges", () => {
    // An outline is not a divider, and on a dark theme it is the only part of the preset that reads:
    // a dark contact shadow on a background darker than the pane is nothing at all.
    const sheet = ruleWith('html[data-boundless][data-shape="slab"] .verta-pane');
    expect(sheet?.body).toContain("border-top-color: var(--pane-border-color)");
    expect(sheet?.body).toContain("border-bottom-color: var(--pane-border-color)");
    // The sides are the ends' business, and the sheet has two of them.
    for (const side of ["left", "right"]) {
      const edge = ruleWith(
        `html[data-boundless][data-shape="slab"] [data-shell][data-edge-${side}] .verta-pane`,
      );
      expect(edge?.body).toContain(`border-${side}-color: var(--pane-border-color)`);
      // The ends keep the width that colour needs; a colour with no width draws nothing.
      expect(edge?.body).toContain(
        `border-${side}-width: var(--pane-border-width)`,
      );
    }
    // And the panes between them stay borderless, or the sheet would have dividers again.
    expect(sheet?.body).not.toContain("border-left-color");
    expect(sheet?.body).not.toContain("border-right-color");
    // Width, not just colour: a transparent border paints its own width with the pane's background,
    // so the 2px it took at a seam was a band of the pane between the sheet and the terminal - the
    // same divider, only thicker.
    expect(sheet?.body).toContain("border-left-width: 0");
    expect(sheet?.body).toContain("border-right-width: 0");
  });

  it("thickens 石板 with the radius", () => {
    // The offsets are the preset's thickness, and thickness is what a radius implies: `1px 1px` for
    // every radius made the same slab out of a 4px corner and a 16px one.
    const slab = resolveShape("slab").vars["--pane-shadow"] ?? "";
    expect(slab).toContain("var(--slab-offset)");
    expect(slab).toContain("var(--slab-lift)");
    expect(resolveShape("slab").vars["--slab-offset"]).toContain("var(--radius)");
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
    // A single line each way is a hairline; a light has a side. The verticals are pieces of their own
    // because 无界 drops exactly those two (see the sheet's rules below).
    expect(plate["--bevel-left"]).toMatch(/inset 1px 0 0 oklch\(1 0 0/);
    expect(plate["--bevel-right"]).toMatch(/inset -1px 0 0 oklch\(0 0 0/);
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
    for (const side of [
      "--bevel-top",
      "--bevel-bottom",
      "--bevel-left",
      "--bevel-right",
      "--bevel-lip",
    ]) {
      expect(rule?.body).toContain(`var(${side})`);
    }
    // Painted, not composited: no blur, no filter, no backdrop (`compositingBudget.test.ts`).
    expect(rule?.body).not.toMatch(/blur|backdrop/);
    expect(rule?.body).not.toMatch(/(?<![-\w])filter:/);
  });

  it("is read off the shape by the sheet, instead of a copy of it", () => {
    // The copy that used to be here was a revision behind - the older, weaker bevel - which is exactly
    // why 浮雕 and 极简 were hard to tell apart under 无界.
    const sheet = ruleWith('html[data-boundless][data-shape="emboss"] .verta-pane');
    expect(sheet?.body).toBe(
      "box-shadow: var(--bevel-top), var(--bevel-bottom), var(--bevel-lip);",
    );
    expect(sheet?.body).not.toMatch(/oklch/);
  });

  it("keeps the sheet's own sides on the panes that own its ends", () => {
    // Every pane painting a left and right edge is a divider inside a sheet; only the ends may, and
    // `data-edge-*` is what says which those are (`shellEdges`).
    const sheet = ruleWith('html[data-boundless][data-shape="emboss"] .verta-pane');
    expect(sheet?.body).not.toContain("--bevel-left");
    expect(sheet?.body).not.toContain("--bevel-right");
    const left = ruleWith(
      'html[data-boundless][data-shape="emboss"] [data-shell][data-edge-left] .verta-pane',
    );
    expect(left?.body).toContain("var(--bevel-left)");
    expect(left?.body).not.toMatch(/oklch/);
    const right = ruleWith(
      'html[data-boundless][data-shape="emboss"] [data-shell][data-edge-right] .verta-pane',
    );
    expect(right?.body).toContain("var(--bevel-right)");
    expect(right?.body).not.toMatch(/oklch/);
  });
});

describe("碳纤维's weave", () => {
  // The texture was the theme's, painted by the theme's surface layer, and "the shape owns the material,
  // the theme owns the colours" took it away with the theme. It is the shape's now, and it has to reach
  // the same three places the theme's surface did: the two layers in the main window and the body of the
  // settings and usage windows (both are their own documents).
  const carbon = resolveShape("carbon");
  const image = carbon.vars["--shape-surface-image"] ?? "";

  it("is painted, not a bitmap and not a layer", () => {
    expect(image).toContain("repeating-linear-gradient");
    // A bitmap would be a resource to ship and a layer to composite; `compositingBudget.test.ts` allows
    // neither by default.
    expect(image).not.toMatch(/url\(/);
    expect(image).not.toMatch(/blur|backdrop/);
    expect(carbon.attrs["data-shape-surface"]).toBe("weave");
  });

  it("asks the surface layer for the drawing rather than the theme's surface", () => {
    // Its own variables: a theme that carries a surface of its own and this shape must not clear one
    // another, and neither may be silently dropped when the other is set.
    expect(carbon.vars["--theme-surface-image"]).toBeUndefined();
  });

  it("is drawn in every window, from the layer under the UI", () => {
    const main = rules.find(
      (rule) => rule.selector.includes("[data-shape-surface] [data-theme-surface-layer]"),
    );
    expect(main?.body, "no rule paints the shape's surface").toContain(
      "var(--shape-surface-image",
    );
    // One rule for all three windows: the layer is mounted by the `ThemeProvider` every window has,
    // and the attribute is on each window's own documentElement.
    expect(main?.selector).toContain("[data-shape-surface]");
    // Not the child windows' `body`: on Windows that element is `transparent !important`, so a body
    // background never showed (measured, with the weave's rule on the body).
    const onBody = rules.find(
      (rule) =>
        rule.selector.includes(":has(:is(#settings-root, #usage-root))") &&
        rule.selector.includes("[data-shape-surface]") &&
        rule.body.includes("var(--shape-surface-image"),
    );
    expect(onBody, "the shape paints a child window's body, which is transparent !important")
      .toBeUndefined();
    // Nor the other layer: `z-index: 0`, portalled after `#root`, so a fabric on it covers the panes
    // and the terminal (measured: the workspace came out striped and its text unreadable).
    const overContent = rules.find(
      (rule) =>
        rule.selector.includes("[data-shape-surface]") &&
        rule.selector.includes("[data-theme-surface-fill]") &&
        rule.body.includes("var(--shape-surface-image"),
    );
    expect(overContent, "the shape paints the layer that sits over the UI").toBeUndefined();
  });

  it("draws nothing when neither a theme nor a shape asks for a surface", () => {
    const hidden = rules.find((rule) => rule.body.includes("display: none") && rule.selector.includes("data-theme-surface-layer"));
    expect(hidden?.selector).toContain(":not([data-shape-surface])");
  });
});
