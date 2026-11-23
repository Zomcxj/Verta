import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { getBuiltinTheme, listBuiltinThemes } from "./index";
import { terax } from "./terax";
import { themeDescription, themeName } from "./themeNames";

/**
 * Terax is a theme in the picker again, and its colours are the ones the stylesheet always held.
 *
 * It was the default until the brand theme took that place, and its palette lived in
 * `styles/globals.css` because `ThemeProvider` skipped `applyTheme` for the default id. Those
 * declarations are still there - they are what every window paints before the theme lands - so the
 * theme file copies them. This file is the thing that stops the two from drifting: a colour changed
 * in one place and not the other is a window whose first paint disagrees with its settled state.
 */
const globals = readFileSync(
  fileURLToPath(new URL("../../../styles/globals.css", import.meta.url)),
  "utf8",
);

/** The `:root` block that carries the palette (not the terminal or frame blocks). */
function block(selector: string): Record<string, string> {
  const start = globals.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in globals.css`);
  const end = globals.indexOf("}", start);
  const declarations: Record<string, string> = {};
  for (const line of globals.slice(start, end).split("\n")) {
    const match = /^\s*(--[a-z-]+):\s*(.+?);\s*$/.exec(line);
    if (match) declarations[match[1]] = match[2];
  }
  return declarations;
}

describe("the Terax theme", () => {
  it("is offered in the picker again, and is not the default", () => {
    const ids = listBuiltinThemes().map((theme) => theme.id);
    expect(ids).toContain("terax");
    // The brand theme still opens a fresh install; restoring this one did not take that back.
    expect(ids[0]).toBe("verta-default");
  });

  it("resolves through the registered lookup", () => {
    expect(getBuiltinTheme("terax")).toBe(terax);
  });

  it("keeps the neutral grey the stylesheet declares, both modes", () => {
    const light = block(":root");
    const dark = block(".dark");
    const pairs = [
      [light, terax.variants.light?.colors],
      [dark, terax.variants.dark?.colors],
    ] as const;
    // The colour tokens both sides name, mapped from the CSS custom property to the theme field.
    const FIELDS = [
      ["--background", "background"],
      ["--foreground", "foreground"],
      ["--card", "card"],
      ["--popover", "popover"],
      ["--primary", "primary"],
      ["--secondary", "secondary"],
      ["--muted", "muted"],
      ["--muted-foreground", "mutedForeground"],
      ["--accent", "accent"],
      ["--destructive", "destructive"],
      ["--border", "border"],
      ["--input", "input"],
      ["--ring", "ring"],
      ["--sidebar", "sidebar"],
      ["--sidebar-accent", "sidebarAccent"],
    ] as const;
    for (const [css, colors] of pairs) {
      if (!colors) continue;
      for (const [property, field] of FIELDS) {
        // A colour that is missing on either side is a drift this test cannot see, so it fails.
        expect(css[property], `${property} is not declared`).toBeDefined();
        expect(colors[field], `${property} in the theme`).toBe(css[property]);
      }
    }
  });

  it("is a theme of its own, not a second name for the brand palette", () => {
    // The two were folded together once; the point of restoring this one is that they differ.
    const brand = getBuiltinTheme("verta-default");
    expect(terax.variants.dark?.colors?.background).not.toBe(brand?.variants.dark?.colors?.background);
  });

  it("names itself in both languages", () => {
    // A proper name, so it reads the same either way; the description follows the interface.
    expect(themeName("terax", terax.name, "en")).toBe("Terax");
    expect(themeName("terax", terax.name, "zh")).toBe("Terax");
    expect(themeDescription("terax", terax.description, "en")).toBe(terax.description);
    expect(themeDescription("terax", terax.description, "zh")).not.toBe(terax.description);
  });
});
