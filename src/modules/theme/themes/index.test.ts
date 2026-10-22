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
    expect(getDefaultTheme()).toBe(listBuiltinThemes()[0]);
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
  const OURS = ["terax-warm", "terax-web"];

  it("gives each of our themes both a dark and a light palette", () => {
    for (const id of OURS) {
      const theme = getBuiltinTheme(id);
      expect(theme, `${id} 没注册`).toBeDefined();
      expect(theme?.variants.dark, `${id} 缺深色`).toBeDefined();
      expect(theme?.variants.light, `${id} 缺浅色`).toBeDefined();
      // 名字是给用户看的界面文案，得是本项目的写法。
      expect(theme?.name.startsWith("Terax")).toBe(true);
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

