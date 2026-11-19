import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { listBuiltinThemes } from "./themes";
import { readableNeutrals } from "./terminalInk";

/**
 * White text on a light theme.
 *
 * Reported as "切到亮色主题后，终端里的白色文字还是白色，白底白字看不清". The palettes are written for a dark
 * background, and most of them do change the *bright* white for a light variant - but the plain one, the
 * slot a shell prompt and `ls` actually use, stayed a pale grey. Measured on the running app with
 * `claude` in light mode: `--terminal-ansi-white` resolved to `#cbc8bd` on `#faf9f5`, a contrast of
 * 1.59:1, and seven of the seventeen light variants were under 2:1.
 *
 * A light palette's two white slots are ink, not paper, so they are darkened toward the theme's own
 * foreground until they clear a floor. Everything else is left alone: black and bright black are
 * already dark on a light background, and in some themes (solarized) they *are* a background colour,
 * which is not this function's business.
 */
const css = readFileSync(new URL("../../styles/globals.css", import.meta.url), "utf8");

/** WCAG contrast between two hex colours, the same arithmetic the function under test uses. */
function luminance(hex: string): number | null {
  const raw = hex.trim().replace("#", "");
  const full =
    raw.length === 3
      ? [...raw].map((c) => c + c).join("")
      : raw.length >= 6
        ? raw.slice(0, 6)
        : null;
  if (full === null || !/^[0-9a-f]{6}$/i.test(full)) return null;
  const parts = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255);
  const linear = parts.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const isLight = (hex: string) => (luminance(hex) ?? 1) > 0.4;

describe("the terminal's white slots on a light palette", () => {
  it("keeps every light variant readable", () => {
    const bad: string[] = [];
    for (const theme of listBuiltinThemes()) {
      for (const mode of ["light", "dark"] as const) {
        const variant = theme.variants[mode];
        const palette = variant?.terminal;
        const background = variant?.colors?.background;
        if (!palette?.ansi || !background || !isLight(background)) continue;
        const ansi = readableNeutrals(palette.ansi, {
          background,
          ink: palette.foreground ?? variant?.colors?.foreground,
        });
        const white = contrast(ansi[7], background) ?? 0;
        const bright = contrast(ansi[15], background) ?? 0;
        if (white < 3 || bright < 4.5) {
          bad.push(`${theme.id}/${mode}: white ${white.toFixed(2)}, bright ${bright.toFixed(2)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("leaves a dark palette exactly as it was", () => {
    const ansi = [
      "#000000", "#cc0000", "#4e9a06", "#c4a000",
      "#3465a4", "#75507b", "#06989a", "#d3d7cf",
      "#555753", "#ef2929", "#8ae234", "#fce94f",
      "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
    ];
    const out = readableNeutrals(ansi, { background: "#101010", ink: "#eeeeec" });
    expect([...out]).toEqual(ansi);
  });

  it("leaves a white that is already readable alone", () => {
    // Solarized's light variant was authored for its own paper: white is a dark slate and bright white
    // is a darker one (measured 12.05 and 16.4 against #fdf6e3). The floor is not an excuse to repaint
    // a palette that was already right - only the seven that came out under 2:1 are touched.
    const ansi = [
      "#eee8d5", "#dc322f", "#859900", "#b58900",
      "#268bd2", "#d33682", "#2aa198", "#073642",
      "#fdf6e3", "#cb4b16", "#93a1a1", "#839496",
      "#657b83", "#6c71c4", "#586e75", "#002b36",
    ];
    const out = readableNeutrals(ansi, { background: "#fdf6e3", ink: "#657b83" });
    expect(out[7]).toBe("#073642");
    expect(out[15]).toBe("#002b36");
  });

  it("does not touch a dark slot that a theme uses as paper", () => {
    // Black and bright black are not ink on a light background in every theme: solarized sets black to
    // the background itself. Only the two white slots are this function's business.
    const ansi = [
      "#fdf6e3", "#dc322f", "#859900", "#b58900",
      "#268bd2", "#d33682", "#2aa198", "#cbc8bd",
      "#fdf6e3", "#cb4b16", "#586e75", "#657b83",
      "#839496", "#6c71c4", "#93a1a1", "#cbc8bd",
    ];
    const out = readableNeutrals(ansi, { background: "#faf9f5", ink: "#3d3a2f" });
    expect(out[0]).toBe("#fdf6e3");
    expect(out[8]).toBe("#fdf6e3");
  });

  it("hands back a palette it cannot read rather than guessing", () => {
    // A custom theme's file is not validated beyond its shape: an `rgba()` slot or a short array must
    // come back exactly as it arrived, not as a half-blended colour.
    const rgba = ["rgba(1,2,3,0.5)", "#000", "#000", "#000", "#000", "#000", "#000", "rgba(250,250,250,1)",
      "#111", "#111", "#111", "#111", "#111", "#111", "#111", "rgba(255,255,255,1)"];
    expect([...readableNeutrals(rgba, { background: "#faf9f5", ink: "#000" })]).toEqual(rgba);
    const short = ["#fff", "#000"];
    expect([...readableNeutrals(short, { background: "#faf9f5", ink: "#000" })]).toEqual(short);
    // No background to judge by: unchanged.
    expect([...readableNeutrals(rgba, { ink: "#000" })]).toEqual(rgba);
  });

  it("the default theme's fallback is derived, not a pale grey", () => {
    // `verta-default` carries no terminal palette at all, so it takes these `:root` values in both
    // modes - and a hard-coded #cfcfcf is 1.6:1 on a white page.
    const root = css.match(/:root\s*\{[^}]*--terminal-ansi-white:\s*([^;]+);/);
    expect(root?.[1]).toContain("var(--foreground)");
    const bright = css.match(/:root\s*\{[^}]*--terminal-ansi-bright-white:\s*([^;]+);/);
    expect(bright?.[1]).toContain("var(--foreground)");
  });
});
