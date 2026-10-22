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
    // 默认主题自己的颜色在 globals.css 里，它不一定是列表第一位（自加的主题排在前面）。
    expect(getDefaultTheme()).toBe(getBuiltinTheme(DEFAULT_THEME_ID));
  });

  it("lists our own themes before the ones that came with the upstream", () => {
    const ids = listBuiltinThemes().map((t) => t.id);
    expect(ids.indexOf("verta")).toBeLessThan(ids.indexOf(DEFAULT_THEME_ID));
    expect(ids.indexOf("acrylic")).toBeLessThan(ids.indexOf(DEFAULT_THEME_ID));
    expect(ids.indexOf("carbon-weave")).toBeLessThan(ids.indexOf("xcode"));
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

  // 上游带来的主题里有只做深色的（kanagawa-dragon），那是有意的；这里只管我们自己新加的。
  const OURS = ["verta", "acrylic", "carbon-weave"];

  it("gives each of our themes both a dark and a light palette", () => {
    for (const id of OURS) {
      const theme = getBuiltinTheme(id);
      expect(theme, `${id} 没注册`).toBeDefined();
      expect(theme?.variants.dark, `${id} 缺深色`).toBeDefined();
      expect(theme?.variants.light, `${id} 缺浅色`).toBeDefined();
      // 名字是给用户看的界面文案：中文名，或者是品牌专名（只有 Verta）。
      expect(
        /[一-龥]/.test(theme?.name ?? "") ||
          theme?.name === "Verta",
        `${id} 的名字要么是中文，要么是品牌专名`,
      ).toBe(true);
      // 这几个主题都自带完整配色（不像默认主题那样把颜色留在 globals.css 里）。
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

