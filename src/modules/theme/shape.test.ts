import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHAPE_ID,
  GLASS_DEFAULT_PARAMS,
  isShapeId,
  isShapePref,
  listShapes,
  resolveShape,
  resolveShapePref,
  SHAPE_AUTO,
  shapeOf,
  shapeUsesGlass,
} from "./shape";

describe("the shape axis", () => {
  it("offers five presets, in the order they are drawn", () => {
    expect(listShapes()).toEqual([
      "boundless",
      "minimal",
      "cloud",
      "emboss",
      "slab",
      "glass",
    ]);
    // Decoration is opt-in: the default paints nothing.
    expect(DEFAULT_SHAPE_ID).toBe("minimal");
    expect(resolveShape(DEFAULT_SHAPE_ID)).toEqual(resolveShape("minimal"));
  });

  it("merges the three regions into one sheet", () => {
    // No border and no gutter (the stylesheet closes that, and its rounding lands on the merged block
    // - see `globals.css`); the radius is no longer this axis's business.
    expect(resolveShape("boundless")).toEqual({
      vars: {
        "--pane-border-width": "0px",
        "--pane-border-color": "transparent",
      },
      attrs: { "data-shape": "boundless" },
      material: false,
    });
  });

  it("draws nothing at all when nothing has been chosen", () => {
    expect(resolveShape("minimal")).toEqual({
      vars: {
        "--pane-border-width": "0px",
        "--pane-border-color": "transparent",
      },
      attrs: { "data-shape": "minimal" },
      material: false,
    });
  });

  it("answers each preset with its own geometry", () => {
    for (const id of listShapes()) {
      const { vars, attrs, material } = resolveShape(id);
      expect(attrs["data-shape"]).toBe(id);
      // Every shape decides a border width, always: the shell reads it.
      expect(vars["--pane-border-width"]).toMatch(/^\d*\.?\d+px$/);
      expect(vars["--pane-border-color"]).toBeTruthy();
      for (const name of Object.keys(vars)) expect(name.startsWith("--")).toBe(true);
      for (const value of Object.values(vars)) expect(value.length).toBeGreaterThan(0);
      expect(material).toBe(id === "glass");
    }
    expect(resolveShape("cloud").vars["--card-shadow"]).toBeDefined();
    expect(resolveShape("emboss").vars["--bevel-top"]).toBeDefined();
    expect(resolveShape("emboss").vars["--bevel-bottom"]).toBeDefined();
    expect(resolveShape("slab").vars["--pane-shadow"]).toBeDefined();
    // Slab is solid, not raised: a lit edge there would be the emboss preset.
    expect(resolveShape("slab").vars["--bevel-top"]).toBeUndefined();
  });

  it("keeps the material and its glass layer on the one preset that asks for them", () => {
    // Acrylic is native DWM material behind the window, out of the stylesheet's reach - and it is the
    // `glass` shape's, not a theme's: this is the axis the material moved onto.
    const glass = resolveShape("glass");
    expect(glass.attrs).toEqual({
      "data-shape": "glass",
      "data-shape-material": "native",
      // Acrylic's own recipe travels with it, because a material behind opaque panes is invisible.
      "data-theme-glass": "on",
    });
    expect(glass.vars["--theme-frame-opacity"]).toBe("0.24");
    expect(glass.vars["--theme-pane-opacity"]).toBe("0.28");
    // And the terminal stops painting the theme's colour: a solid rectangle in a translucent window
    // is the one place acrylic looked broken.
    expect(glass.vars["--terminal-background"]).toBe("transparent");
    for (const id of listShapes()) {
      if (id === "glass") continue;
      expect(resolveShape(id).attrs["data-shape-material"]).toBeUndefined();
      expect(resolveShape(id).vars["--theme-frame-opacity"]).toBeUndefined();
      expect(resolveShape(id).vars["--terminal-background"]).toBeUndefined();
    }
  });

  it("resets to the numbers the preset itself draws with", () => {
    // "Restore defaults" must write what `glass` ships with, not a second copy of the numbers kept
    // somewhere else, so the constant and the preset are checked against each other.
    const glass = resolveShape("glass");
    expect(glass.vars["--theme-pane-opacity"]).toBe(
      `${GLASS_DEFAULT_PARAMS.paneOpacity}`,
    );
    expect(glass.vars["--theme-glass-edge"]).toBe(`${GLASS_DEFAULT_PARAMS.edge}`);
    expect(glass.vars["--theme-glass-sheen"]).toBe(
      `${GLASS_DEFAULT_PARAMS.sheen}`,
    );
  });

  it("lets the user's three numbers replace a material shape's recipe", () => {
    const tuned = resolveShape("glass", {
      glass: { paneOpacity: 0.12, edge: 0.7, sheen: 0.3 },
    });
    expect(tuned.vars["--theme-pane-opacity"]).toBe("0.12");
    expect(tuned.vars["--theme-glass-edge"]).toBe("0.7");
    expect(tuned.vars["--theme-glass-sheen"]).toBe("0.3");
    // A shape with no material ignores them: there is no layer for them to describe.
    const slab = resolveShape("slab", {
      glass: { paneOpacity: 0.12, edge: 0.7, sheen: 0.3 },
    });
    expect(slab.vars["--theme-pane-opacity"]).toBeUndefined();
    // And a theme that carries its own glass is not overruled by the sliders.
    const themed = resolveShape("glass", {
      themeGlass: true,
      glass: { paneOpacity: 0.12, edge: 0.7, sheen: 0.3 },
    });
    expect(themed.vars["--theme-pane-opacity"]).toBeUndefined();
  });

  it("knows which shapes the sliders belong to", () => {
    expect(shapeUsesGlass("glass")).toBe(true);
    expect(shapeUsesGlass("slab")).toBe(false);
    expect(shapeUsesGlass(SHAPE_AUTO)).toBe(false);
  });

  it("puts the theme's terminal colour back when the material goes away", () => {
    // Switching glass -> slab has to restore the background the theme asked for, not leave a
    // see-through terminal behind.
    expect(
      resolveShape("slab", { themeTerminal: "rgba(21, 27, 32, 0)" }).vars[
        "--terminal-background"
      ],
    ).toBe("rgba(21, 27, 32, 0)");
    // The material's own answer wins over the theme's colour while it is on.
    expect(
      resolveShape("glass", { themeTerminal: "#101010" }).vars[
        "--terminal-background"
      ],
    ).toBe("transparent");
  });

  it("leaves a theme's own glass alone when the theme has one", () => {
    // A theme that describes its glass - a custom one can - is not overruled by the shape's recipe.
    const themed = resolveShape("glass", { themeGlass: true });
    expect(themed.material).toBe(true);
    expect(themed.vars["--theme-frame-opacity"]).toBeUndefined();
    expect(themed.vars["--theme-pane-opacity"]).toBeUndefined();
    expect(themed.attrs["data-theme-glass"]).toBeUndefined();
    expect(themed.attrs["data-shape"]).toBe("glass");
  });

  it("never writes a colour the browser will throw away", () => {
    // Measured the hard way: `color-mix(in oklab, var(--border) 140%, ...)` is invalid - the
    // percentages of a mix cannot exceed 100 - and an invalid custom property makes the whole
    // `border` shorthand invalid at computed-value time, which drops `border-style` to `none` and the
    // pane's border to 0px. The shape then looks like it lost its border rather than its colour.
    for (const id of listShapes()) {
      const colour = resolveShape(id).vars["--pane-border-color"];
      for (const [, mix] of colour.matchAll(/color-mix\(([^)]*)\)/g)) {
        const percentages = [...mix.matchAll(/(-?\d+(?:\.\d+)?)%/g)].map((m) =>
          Number(m[1]),
        );
        expect(percentages.every((p) => p >= 0 && p <= 100), `${id}: ${colour}`).toBe(
          true,
        );
        expect(
          percentages.reduce((a, b) => a + b, 0),
          `${id}: ${colour}`,
        ).toBeLessThanOrEqual(100);
      }
    }
  });

  it("gives each shape a border colour, since half a pixel is drawn as one", () => {
    const colours = listShapes().map(
      (id) => resolveShape(id).vars["--pane-border-color"],
    );
    expect(new Set(colours).size).toBeGreaterThan(2);
    for (const colour of colours) expect(colour).toBeTruthy();
  });

  it("falls back to the default preset for an id it does not know", () => {
    // A hand-edited theme file with a typo in `shape` has to open, not blank the window.
    for (const unknown of ["rounded", "soft", "", undefined, null, 42, {}]) {
      expect(isShapeId(unknown)).toBe(false);
      expect(shapeOf(unknown)).toBe("minimal");
      expect(resolveShape(unknown)).toEqual(resolveShape("minimal"));
    }
    expect(isShapeId("emboss")).toBe(true);
    expect(shapeOf("emboss")).toBe("emboss");
  });

  it("lets a theme suggest a shape only while nothing has been chosen", () => {
    // `auto` is no longer something a user can pick; it is the state of never having picked, which is
    // what lets the acrylic colours still suggest the glass shape.
    expect(SHAPE_AUTO).toBe("auto");
    expect(resolveShapePref(SHAPE_AUTO, "glass")).toBe("glass");
    expect(resolveShapePref(undefined, "emboss")).toBe("emboss");
    expect(resolveShapePref(SHAPE_AUTO, undefined)).toBe("minimal");
    // A suggestion nothing recognises is the same as none.
    expect(resolveShapePref(SHAPE_AUTO, "squircle")).toBe("minimal");
    // A choice wins over the suggestion, and stays after the theme changes.
    expect(resolveShapePref("slab", "glass")).toBe("slab");
    expect(resolveShapePref("slab", undefined)).toBe("slab");
    expect(isShapePref("glass")).toBe(true);
    expect(isShapePref("squircle")).toBe(false);
  });
});
