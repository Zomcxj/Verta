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
describe("云朵's shadow at the sheet's four corners", () => {
  // Reported three times over: "云朵形态在圆角阴影上还是不行", then "云朵让你改的四个角落 不是分隔处", then
  // "角落多了一层" with the sheet's own edge in 石板 as the same complaint. All of them are one rule: a
  // shadow is cast by the box that carries it, and the only box whose corners can be the sheet's corners
  // is the box that *is* the sheet.
  const row = ruleWith(
    'html[data-boundless][data-shape="cloud"] [data-slot="resizable-panel-group"]:not(.verta-pane *)',
  );

  it("gives the box that casts the sheet's shadow the sheet's own radius", () => {
    expect(row?.body).toContain("border-radius: var(--pane-radius)");
    expect(row?.body).toContain("box-shadow:");
  });

  it("casts all four bands from that one box", () => {
    // Split between the row (top and bottom) and the panes at the row's ends (left and right), the two
    // halves were shadows of two different boxes: they met at each corner as a second, offset arc -
    // "角落多了一层" - and a pane's band, being inside the sheet, bled across the seam it sat next to.
    for (const band of ["0 -10px 22px 1px", "0 10px 22px 1px", "-10px 0 22px 1px", "10px 0 22px 1px"]) {
      expect(row?.body, band).toContain(band);
    }
    // The panes keep the hairline and nothing else: an outer band here is a band from the wrong box.
    expect(ruleWith('html[data-boundless][data-shape="cloud"] .verta-pane')?.body).toBe(
      "box-shadow: inset 0 1px 0 oklch(1 0 0 / 0.1);",
    );
    expect(
      ruleWith('html[data-boundless][data-shape="cloud"] [data-shell][data-edge-left] .verta-pane'),
    ).toBeUndefined();
    expect(
      ruleWith('html[data-boundless][data-shape="cloud"] [data-shell][data-edge-right] .verta-pane'),
    ).toBeUndefined();
  });

  it("takes its weight from the per-mode ink, the same one the preset reads", () => {
    // "阴影过重，亮色下或许突兀": one fixed alpha cannot serve both modes. The sheet and the preset's own
    // recipe read one variable, so a change of weight is made once.
    expect(row?.body).toContain("var(--float-shadow-ink)");
    expect(row?.body).not.toMatch(/oklch\(0 0 0/);
    expect(resolveShape("cloud").vars["--pane-shadow"]).toContain("var(--float-shadow-ink)");
    // Two blocks, one per mode; the sheet has several `:root` blocks, so they are found by what they set.
    const ink = rules.filter((rule) => rule.body.includes("--float-shadow-ink:"));
    const dark = ink.find((rule) => rule.selector === ":root");
    const light = ink.find((rule) => rule.selector === "html:not(.dark)");
    expect(dark, "no dark ink").toBeDefined();
    expect(light, "no light ink").toBeDefined();
    expect(dark?.body).toContain("oklch(0 0 0 /");
    // Lighter in the light mode, which is the whole point of splitting it.
    const alpha = (body: string) => Number(body.match(/--float-shadow-ink: [^;]*\/ ([\d.]+)\)/)?.[1]);
    expect(alpha(light?.body ?? "")).toBeLessThan(alpha(dark?.body ?? ""));
  });

  it("lays the row out as the sheet, so its corners are the card's corners", () => {
    // The window's margin used to be padding on this row, which put it *inside* the box: the box casting
    // the sheet's shadow was 8px wider than the card on every side, and its shadow filled the notch
    // between its own corner and the card's arc. A margin is the same 8px in the same place, and the box
    // is the card. `width` is spelled out because the panel library writes `width: 100%` inline.
    const sheet = ruleWith(
      'html[data-boundless] [data-slot="resizable-panel-group"]:not(.verta-pane *)',
    );
    expect(sheet?.body).toContain("margin-inline: 0.5rem");
    expect(sheet?.body).toContain("width: calc(100% - 1rem) !important");
    expect(sheet?.body).toContain("padding-inline: 0");
  });

  it("is the shell's row and not a split terminal's row", () => {
    // A split terminal is built from the same `ResizablePanelGroup`, so every rule written for the sheet
    // landed on it too: the 8px margin inset the terminal area from its own pane, and the float's four
    // bands were cast again inside it. On 云朵 that reads as the terminal bulging out of the pane once it
    // is split ("云朵分屏时候终端会突起"). A row inside a pane is a layout of that pane's content.
    const sheetRows = rules.filter(
      (rule) => rule.selector.includes('data-slot="resizable-panel-group"') && rule.selector.includes("data-boundless"),
    );
    expect(sheetRows.length, "no boundless row rules to check").toBeGreaterThan(0);
    for (const rule of sheetRows) {
      expect(rule.selector, `${rule.selector} would land on a split terminal`).toContain(
        ":not(.verta-pane *)",
      );
    }
  });

  it("does not shrink the shadow's corner with a negative spread", () => {
    // A shadow is the element's box inflated by `spread` and rounded by the same radius, so a negative
    // spread takes the radius down with it: at the default 14px pane radius, `-8px` drew a 6px corner
    // and the shadow stopped short of the card's arc at all four corners.
    const body = row?.body ?? "";
    expect(body).toContain("box-shadow:");
    expect(body).not.toMatch(/\d+px\s+\d+px\s+-\d+px/);
    // And the preset's own recipe, which is what the panes read when the sheet is not merged.
    const shadow = resolveShape("cloud").vars["--pane-shadow"] ?? "";
    expect(shadow).not.toMatch(/\d+px\s+\d+px\s+-\d+px/);
  });
});

describe("石板's step under 无界", () => {
  // Reported as "石板有直角阴影". The step is cast outside the pane, and a pane's wrapper clips (inline
  // `overflow: auto`), so what survived of it was the part inside the pane's rounded corner - where the
  // pane's own background does not cover its box - and that is a dark square in each corner.
  it("is cast by the sheet's box, not by each pane", () => {
    const row = ruleWith(
      'html[data-boundless][data-shape="slab"] [data-slot="resizable-panel-group"]:not(.verta-pane *)',
    );
    expect(row?.body).toContain("border-radius: var(--pane-radius)");
    expect(row?.body).toContain("0 var(--slab-offset) 0");
    const pane = ruleWith('html[data-boundless][data-shape="slab"] .verta-pane');
    expect(pane?.body).toContain("box-shadow: none;");
    expect(pane?.body).not.toContain("--slab-offset");
    // The one cut face the preset keeps on the sheet's right edge, and nothing of the step's.
    const right = ruleWith(
      'html[data-boundless][data-shape="slab"] [data-shell][data-edge-right] .verta-pane',
    );
    expect(right?.body).not.toContain("var(--pane-shadow)");
    expect(right?.body).toContain("inset -3px 0 0");
  });

  it("may leave the pane it is cast from", () => {
    // Both shapes that draw outside the pane's box need the wrappers' clipping released, and the rule is
    // written once for the two of them rather than copied per shape.
    const release = rules.find(
      (rule) => rule.body.includes("overflow: visible !important") && rule.selector.includes("data-panel"),
    );
    expect(release, "no shape releases the panel's clipping").toBeDefined();
    expect(release?.selector).toContain('html[data-shape="cloud"]');
    expect(release?.selector).toContain('html[data-shape="slab"]');
  });
});
