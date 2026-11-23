import { describe, expect, it } from "vitest";
import { DEFAULT_THEME_ID } from "@/modules/theme/types";
import {
  getBuiltinTheme,
  getDefaultTheme,
  listBuiltinThemes,
} from "@/modules/theme/themes/index";

describe("builtin theme registry", () => {
  it("exposes a non-empty list of themes", () => {
    expect(listBuiltinThemes().length).toBeGreaterThan(0);
  });

  it("has a unique id per theme", () => {
    const ids = listBuiltinThemes().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves every listed theme by its id", () => {
    for (const theme of listBuiltinThemes()) {
      expect(getBuiltinTheme(theme.id)).toBe(theme);
    }
  });

  it("gives every built-in theme both palettes", () => {
    // A theme with only a dark variant is a theme that cannot follow the system into daylight, and
    // the settings list cannot be one list without them all having the same two answers.
    const missing = listBuiltinThemes()
      .filter((t) => !t.variants.light || !t.variants.dark)
      .map((t) => t.id);
    expect(missing).toEqual([]);
  });

  it("no longer offers acrylic as a theme, but still resolves it", () => {
    // The material became the `acrylic` shape, so acrylic is no longer a thing a theme has to be - it
    // is colours that suggest that shape. A settings file that still says `themeId: "acrylic"` has to
    // open as those colours in acrylic, not silently fall back to the default theme.
    expect(listBuiltinThemes().map((t) => t.id)).not.toContain("acrylic");
    expect(getBuiltinTheme("acrylic")?.shape).toBe("acrylic");
  });

  it("returns undefined for an unknown id", () => {
    expect(getBuiltinTheme("no-such-theme")).toBeUndefined();
  });

  it("resolves the default theme through the registered-theme lookup", () => {
    expect(getDefaultTheme()).toBe(getBuiltinTheme(DEFAULT_THEME_ID));
  });

  it("falls back to the first registered theme if the default is missing", () => {
    const ids = listBuiltinThemes().map((t) => t.id);
    expect(ids).not.toContain("__fallback__");
    expect(getBuiltinTheme("__fallback__")).toBeUndefined();
    // The default theme keeps its colours in globals.css, and it is the first row of the list.
    expect(ids[0]).toBe(DEFAULT_THEME_ID);
    expect(getDefaultTheme()).toBe(getBuiltinTheme(DEFAULT_THEME_ID));
  });

  it("puts the brand theme first, then every other theme by its first letter", () => {
    const themes = listBuiltinThemes();
    const ids = themes.map((t) => t.id);
    // Every id asserted on below has to be in the list: `indexOf` answers -1 for one that is not,
    // and -1 < anything passes without testing anything. That is what happened here when the
    // brand theme was folded into `verta-default` and `verta` stopped existing.
    for (const id of ["verta-default", "carbon-weave", "xcode", "terax"]) {
      expect(ids, `${id} is not listed`).toContain(id);
    }
    // The brand theme is the default and the first row, so it is not one of the entries below it.
    expect(themes[0].id).toBe(DEFAULT_THEME_ID);
    // Below it the order is the display name's, because the name is what the list shows - sorting on
    // the id would file `verta-default` under V and `atom-one` under A by accident of file naming.
    const rest = themes.slice(1);
    for (let i = 1; i < rest.length; i += 1) {
      const previous = rest[i - 1];
      const current = rest[i];
      expect(
        previous.name.localeCompare(current.name, "en"),
        `${previous.name} should not come after ${current.name}`,
      ).toBeLessThanOrEqual(0);
    }
    // `Atom One` took the `carbon-weave` slot from Carbon Fiber, so it is an A and comes before
    // Xcode; `Terax` is a T.
    expect(ids.indexOf("carbon-weave")).toBeLessThan(ids.indexOf("terax"));
    expect(ids.indexOf("terax")).toBeLessThan(ids.indexOf("xcode"));
    // `acrylic` stopped being a theme - the material it named is the `glass` shape now - so a
    // settings file may still name it but the picker must not offer it.
    expect(ids).not.toContain("acrylic");
  });
});

describe("builtin theme palettes", () => {
  const REQUIRED = [
    "background",
    "foreground",
    "card",
    "popover",
    "primary",
    "primaryForeground",
    "muted",
    "mutedForeground",
    "accent",
    "destructive",
    "border",
    "input",
    "ring",
    "sidebar",
    "sidebarForeground",
  ] as const;

  // Some themes that came with the upstream are dark-only (kanagawa-dragon), deliberately; this
  // only covers the ones we add ourselves.
  const OURS = ["verta-default", "acrylic", "carbon-weave"];
  // These names are kept in English on purpose: one is a brand name, the other two name a material
  // and a palette.
  const ENGLISH_NAMES = new Set(["Verta", "Acrylic", "Atom One"]);

  it("gives each of our themes both a dark and a light palette", () => {
    for (const id of OURS) {
      const theme = getBuiltinTheme(id);
      expect(theme, `${id} 没注册`).toBeDefined();
      expect(theme?.variants.dark, `${id} 缺深色`).toBeDefined();
      expect(theme?.variants.light, `${id} 缺浅色`).toBeDefined();
      // The name is user-facing copy: a Chinese name, or one of the English names kept on purpose (above).
      expect(
        /[一-龥]/.test(theme?.name ?? "") ||
          ENGLISH_NAMES.has(theme?.name ?? ""),
        `${id} 的名字要么是中文，要么是有意留的英文名`,
      ).toBe(true);
      // These themes carry a full palette of their own.
      expect(theme?.variants.dark?.colors).toBeTruthy();
    }
  });

  it("fills in every colour both modes need, so no pane falls back to another theme", () => {
    for (const id of OURS) {
      const theme = getBuiltinTheme(id);
      if (!theme) continue;
      for (const mode of ["dark", "light"] as const) {
        const colors = theme.variants[mode]?.colors ?? {};
        for (const key of REQUIRED) {
          expect(colors[key], `${theme.id}.${mode}.${key}`).toBeTruthy();
        }
        const ansi = theme.variants[mode]?.terminal?.ansi;
        if (ansi) expect(ansi, `${theme.id}.${mode}.ansi`).toHaveLength(16);
      }
    }
  });

});

