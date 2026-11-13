import { useTheme } from "@/modules/theme";
import { useMemo } from "react";

/**
 * Colours for the chart's series, derived from the theme's accent.
 *
 * A fixed palette would fight the dozen themes this app ships, light and dark; a single accent for
 * every bar would make a stack unreadable. So series 0 is the accent itself and each next one takes
 * a step of the golden angle around the wheel, with lightness and saturation pulled into a range
 * that stays legible on the current background. Steps go around the wheel rather than along a
 * gradient because two neighbours on a gradient are exactly the two colours a stacked bar most
 * needs to keep apart.
 */

/** 360 / phi: successive series land far apart instead of walking around the wheel. */
const GOLDEN_ANGLE = 137.508;

type Hsl = { h: number; s: number; l: number };

function parseHex(value: string | undefined): Hsl | null {
  if (value === undefined) return null;
  const hex = value.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(hex) && !/^[0-9a-f]{3}$/i.test(hex)) return null;
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((part) => part + part)
          .join("")
      : hex;
  const r = Number.parseInt(full.slice(0, 2), 16) / 255;
  const g = Number.parseInt(full.slice(2, 4), 16) / 255;
  const b = Number.parseInt(full.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const delta = max - min;
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / delta + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / delta + 2) * 60;
  else h = ((r - g) / delta + 4) * 60;
  return { h, s: s * 100, l: l * 100 };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function hsl(h: number, s: number, l: number, alpha = 1): string {
  const hue = Math.round(((h % 360) + 360) % 360);
  const saturation = Math.round(s);
  const lightness = Math.round(l);
  return alpha >= 1
    ? `hsl(${hue} ${saturation}% ${lightness}%)`
    : `hsl(${hue} ${saturation}% ${lightness}% / ${alpha})`;
}

/**
 * The accent, as a hue to step around.
 *
 * A theme whose accent is nearly black or white has no hue to step: it falls back to a blue that
 * reads on both backgrounds instead of to a row of identical greys.
 */
function accentOf(primary: string | undefined, dark: boolean): Hsl {
  const parsed = parseHex(primary);
  if (parsed === null || parsed.s < 8) {
    return dark ? { h: 210, s: 60, l: 68 } : { h: 216, s: 65, l: 46 };
  }
  return parsed;
}

/** Series colours for the current theme, one per index. */
export function useSeriesColors(count: number): string[] {
  const { activeTheme, resolvedMode } = useTheme();
  const dark = resolvedMode === "dark";
  const primary = (
    dark ? activeTheme?.variants?.dark : activeTheme?.variants?.light
  )?.colors?.primary;

  return useMemo(() => {
    const accent = accentOf(primary, dark);
    const colors: string[] = [];
    for (let index = 0; index < Math.max(count, 1); index += 1) {
      if (index === 0) {
        colors.push(
          hsl(accent.h, clamp(accent.s, 35, 95), clamp(accent.l, 32, 76)),
        );
        continue;
      }
      // Alternating saturation and lightness levels keep two hues that end up adjacent apart.
      const saturation = clamp(
        index % 3 === 0 ? accent.s * 1.05 : accent.s * 0.85,
        38,
        88,
      );
      const lightness = dark
        ? clamp(62 + (index % 2) * 6, 56, 78)
        : clamp(46 - (index % 2) * 6, 30, 56);
      colors.push(hsl(accent.h + index * GOLDEN_ANGLE, saturation, lightness));
    }
    return colors;
  }, [count, dark, primary]);
}

/** The accent at a given alpha: the heatmap's levels are one hue at four opacities. */
export function useAccentAlpha(): (alpha: number) => string {
  const { activeTheme, resolvedMode } = useTheme();
  const dark = resolvedMode === "dark";
  const primary = (
    dark ? activeTheme?.variants?.dark : activeTheme?.variants?.light
  )?.colors?.primary;
  return useMemo(() => {
    const accent = accentOf(primary, dark);
    return (alpha: number) => hsl(accent.h, accent.s, accent.l, alpha);
  }, [dark, primary]);
}
