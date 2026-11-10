import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHAPE_ID,
  isShapeId,
  isShapePref,
  listShapes,
  resolveShape,
  resolveShapePref,
  SHAPE_AUTO,
  shapeOf,
} from "./shape";

describe("the shape axis", () => {
  it("offers the nine presets in the order they are drawn", () => {
    expect(listShapes()).toEqual([
      "soft",
      "fine",
      "minimal",
      "tag",
      "cloud",
      "emboss",
      "slab",
      "band",
      "glass",
    ]);
    expect(DEFAULT_SHAPE_ID).toBe("soft");
  });

  it("leaves the shell exactly as it was when nothing has been chosen", () => {
    // The whole staged point of this file: `soft` is the values the stylesheet already had, so a
    // build with no shape preference looks pixel-identical to one from before the axis existed.
    expect(resolveShape("soft")).toEqual({
      vars: { "--pane-border-width": "1px", "--radius": "0.625rem" },
      attrs: { "data-shape": "soft" },
    });
    expect(resolveShape(DEFAULT_SHAPE_ID)).toEqual(resolveShape("soft"));
  });

  it("answers each preset with its own geometry", () => {
    const minimal = resolveShape("minimal");
    expect(minimal.vars["--radius"]).toBe("0");
    expect(minimal.vars["--pane-border-width"]).toBe("0px");
    // Nothing is raised and nothing glows: a preset that said otherwise would be a different shape.
    expect(minimal.vars["--pane-shadow"]).toBeUndefined();
    expect(minimal.vars["--card-shadow"]).toBeUndefined();

    for (const id of listShapes()) {
      const { vars, attrs } = resolveShape(id);
      expect(attrs["data-shape"]).toBe(id);
      // Every shape decides a border width, always: the shell reads it unconditionally.
      expect(vars["--pane-border-width"]).toMatch(/^\d*\.?\d+px$/);
      for (const name of Object.keys(vars)) expect(name.startsWith("--")).toBe(true);
      for (const value of Object.values(vars)) expect(value.length).toBeGreaterThan(0);
    }
  });

  it("keeps the material as an attribute, because CSS cannot draw it", () => {
    // Acrylic is native DWM material behind the window, out of the stylesheet's reach.
    expect(resolveShape("glass").attrs).toEqual({
      "data-shape": "glass",
      "data-shape-material": "native",
    });
    for (const id of listShapes()) {
      if (id === "glass") continue;
      expect(resolveShape(id).attrs["data-shape-material"]).toBeUndefined();
    }
  });

  it("lets a theme's own radius win over the shape's", () => {
    // Eight built-in themes spell `colors.radius` in fifteen places; a palette that deliberately
    // squares its corners must not be re-squared by whichever shape is in force.
    const withThemeRadius = resolveShape("tag", { themeRadius: "2px" });
    expect(withThemeRadius.vars["--radius"]).toBeUndefined();
    expect(withThemeRadius.vars["--pane-border-width"]).toBe("0.5px");
    // An empty string is not a radius, so the shape speaks.
    expect(resolveShape("tag", { themeRadius: "" }).vars["--radius"]).toBe("1.25rem");
  });

  it("falls back to the default preset for an id it does not know", () => {
    // A hand-edited theme file with a typo in `shape` has to open, not blank the window.
    for (const unknown of ["rounded", "", undefined, null, 42, {}]) {
      expect(isShapeId(unknown)).toBe(false);
      expect(shapeOf(unknown)).toBe("soft");
      expect(resolveShape(unknown)).toEqual(resolveShape("soft"));
    }
    expect(isShapeId("emboss")).toBe(true);
    expect(shapeOf("emboss")).toBe("emboss");
  });

  it("lets a chosen shape outlive a change of theme, and follows the theme otherwise", () => {
    // The preference stores `auto` until someone chooses, which is what keeps "picked soft on
    // purpose" apart from "never picked anything".
    expect(SHAPE_AUTO).toBe("auto");
    expect(resolveShapePref(SHAPE_AUTO, "emboss")).toBe("emboss");
    expect(resolveShapePref(undefined, "emboss")).toBe("emboss");
    expect(resolveShapePref(SHAPE_AUTO, undefined)).toBe("soft");
    // A suggestion nothing recognises is the same as none.
    expect(resolveShapePref(SHAPE_AUTO, "squircle")).toBe("soft");
    // A choice wins over the suggestion, and stays after the theme changes.
    expect(resolveShapePref("tag", "emboss")).toBe("tag");
    expect(resolveShapePref("tag", undefined)).toBe("tag");
    // `soft` is a shape someone may have chosen, not a synonym for auto.
    expect(resolveShapePref("soft", "emboss")).toBe("soft");
    expect(isShapePref("auto")).toBe(true);
    expect(isShapePref("emboss")).toBe(true);
    expect(isShapePref("squircle")).toBe(false);
  });

  it("gives the presets that are more than geometry their own variables", () => {
    expect(resolveShape("cloud").vars["--card-shadow"]).toBeDefined();
    expect(resolveShape("emboss").vars["--bevel-top"]).toBeDefined();
    expect(resolveShape("emboss").vars["--bevel-bottom"]).toBeDefined();
    expect(resolveShape("slab").vars["--pane-shadow"]).toBeDefined();
    expect(resolveShape("band").vars["--accent-bar"]).toBe("var(--primary)");
    // Slab is solid, not raised: a lit edge there would be the emboss preset.
    expect(resolveShape("slab").vars["--bevel-top"]).toBeUndefined();
  });
});
