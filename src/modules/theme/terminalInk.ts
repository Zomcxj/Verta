/**
 * The two "white" ANSI slots, made readable on a light background.
 *
 * Terminal palettes are written for a dark background, and a light variant usually changes only the
 * bright white. What is left is a plain white that a prompt, `ls` or a TUI writes with `\e[37m` - a
 * pale grey on a near-white page. Measured on the running app with `claude` in light mode:
 * `--terminal-ansi-white` resolved to `#cbc8bd` on `#faf9f5`, 1.59:1, and seven of the seventeen light
 * variants were under 2:1.
 *
 * On a light background those two slots are ink, not paper, so they are blended toward the theme's own
 * foreground (which keeps the hue it chose) until they clear a floor. Nothing else is touched: black and
 * bright black are dark already, and in some palettes (solarized) they *are* a background colour, which
 * is a theme's own decision to make.
 *
 * A palette this function cannot read - an `rgba()` slot, a short array, a background it cannot parse -
 * is handed back exactly as it arrived. A terminal palette that is half-adjusted is worse than one that
 * is wrong in a way its theme author can see.
 */

/** Below this relative luminance a background is dark, and the palette needs nothing. */
const LIGHT_BACKGROUND = 0.4;

/** The slots whose meaning changes on a light background: white, and bright white. */
const SLOTS = [
  // Secondary ink: a prompt's punctuation, `ls`'s directory colour.
  { index: 7, floor: 3 },
  // Emphasis ink: what a TUI reaches for when it wants your attention.
  { index: 15, floor: 4.5 },
] as const;

/** WCAG relative luminance, or `null` for a colour this cannot read as hex. */
function luminance(hex: string): number | null {
  const parts = parseHex(hex);
  if (parts === null) return null;
  const linear = parts.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function parseHex(value: string | undefined): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().replace(/^#/, "");
  const full =
    raw.length === 3
      ? [...raw].map((c) => c + c).join("")
      : raw.length === 6
        ? raw
        : null;
  if (full === null || !/^[0-9a-f]{6}$/i.test(full)) return null;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

function toHex(rgb: readonly number[]): string {
  return `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** Contrast ratio between two luminances, the WCAG form: (lighter + 0.05) / (darker + 0.05). */
function ratio(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The palette, with slots 7 and 15 dark enough to read on `options.background`.
 *
 * `ink` is the colour they are pulled toward - the theme's terminal foreground, or its page
 * foreground when the variant has no terminal foreground of its own. Without one, black, which is the
 * strongest thing a light background can carry.
 */
export function readableNeutrals<T extends readonly string[]>(
  ansi: T,
  options: { background?: string; ink?: string } = {},
): T | readonly string[] {
  const background = options.background === undefined ? null : luminance(options.background);
  if (background === null || background <= LIGHT_BACKGROUND) return ansi;
  if (ansi.length < 16) return ansi;

  const ink = parseHex(options.ink) ?? parseHex("#000000");
  if (ink === null) return ansi;

  const out = [...ansi];
  for (const { index, floor } of SLOTS) {
    const from = parseHex(out[index]);
    if (from === null) continue; // nothing to blend from: leave the slot alone
    if (ratio(luminance(out[index]) ?? 0, background) >= floor) continue;
    out[index] = blendUntilReadable(from, ink, background, floor);
  }
  return out;
}

/**
 * Pull `from` toward `ink` in 2% steps and stop at the first colour that clears `floor`.
 *
 * A step rather than the arithmetic answer, because the answer is not always reachable from the theme's
 * own ink: a palette whose foreground is a light-mid grey cannot darken a white enough on its own, and
 * the floor is the promise this function makes.
 */
function blendUntilReadable(
  from: readonly number[],
  ink: readonly number[],
  background: number,
  floor: number,
): string {
  for (let step = 2; step <= 100; step += 2) {
    const t = step / 100;
    const mixed = from.map((c, i) => c * (1 - t) + ink[i] * t);
    if (ratio(luminance(toHex(mixed)) ?? 0, background) >= floor) return toHex(mixed);
  }
  // Even the theme's own ink is not enough: black is, on any background this function was asked about.
  return toHex([0, 0, 0]);
}
