import { describe, expect, it } from "vitest";

import { INK_FLOOR, INVISIBLE_INK, readableInk } from "./readableInk";

/**
 * A program's ink that assumes a page it is not on.
 *
 * Reported as "我打开了opencode还是灰色字啊", after the faint fix had already landed. The remaining grey
 * was not dimming at all: opencode's default theme is built dark (`background.base = neutral.800`,
 * `text.base = neutral.200`), so on Verta's white paper its secondary lines were drawn `#eeeeee` -
 * measured on the running app at 1.16:1, a smudge rather than a sentence.
 */
function channels(color: number): [number, number, number] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

function luminance(color: number): number {
  const [r, g, b] = channels(color).map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: number, b: number): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE = 0xffffff;
const PAPER_DARK = 0x141414;

describe("ink that cannot be told apart from its own page", () => {
  it("rescues the measured case", () => {
    // opencode's secondary lines: #eeeeee on white, 1.16:1.
    expect(contrast(0xeeeeee, WHITE)).toBeLessThan(INVISIBLE_INK);
    const rescued = readableInk(0xeeeeee, WHITE);
    expect(rescued).not.toBe(0xeeeeee);
    expect(contrast(rescued, WHITE)).toBeGreaterThanOrEqual(INK_FLOOR);
    // Darkened, not recoloured: it was already neutral, so it stays neutral.
    const [r, g, b] = channels(rescued);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(1);
  });

  it("leaves every colour that was already drawing text exactly alone", () => {
    // The two levels opencode actually uses, and the terminal's own ink: all above the threshold.
    for (const ink of [0x111111, 0x808080, 0x6ba1e6, 0xec5b2b, 0x000000]) {
      expect(readableInk(ink, WHITE)).toBe(ink);
    }
    // 3.95:1 is quiet, and quiet was the program's decision.
    expect(contrast(0x808080, WHITE)).toBeGreaterThan(INVISIBLE_INK);
  });

  it("does not touch a shade that was meant to be subtle", () => {
    // Just above the threshold: a deliberate 1.6:1 tint stays a 1.6:1 tint.
    const subtle = 0xcbcbcb; // 1.60:1 on white
    expect(contrast(subtle, WHITE)).toBeGreaterThan(INVISIBLE_INK);
    expect(readableInk(subtle, WHITE)).toBe(subtle);
  });

  it("goes the other way on a dark page", () => {
    // Ink for a white page landing on a near-black one is the same complaint mirrored: #141414 on
    // #0b0b0b is 1.08:1, and the rescue lightens it rather than darkening it.
    expect(contrast(0x141414, 0x0b0b0b)).toBeLessThan(INVISIBLE_INK);
    const rescued = readableInk(0x141414, 0x0b0b0b);
    expect(contrast(rescued, 0x0b0b0b)).toBeGreaterThanOrEqual(INK_FLOOR);
    expect(luminance(rescued)).toBeGreaterThan(luminance(0x141414));
    // A white page's ordinary ink on a dark page is not invisible at all: untouched.
    expect(readableInk(0xf7f7f7, PAPER_DARK)).toBe(0xf7f7f7);
  });

  it("judges against the cell's own background, not the theme's page", () => {
    // A light ink on a dark chip inside a light window is legible where it sits, so nothing happens.
    expect(readableInk(0xeeeeee, 0x202020)).toBe(0xeeeeee);
    // The same ink on the white paper around that chip does get rescued.
    expect(readableInk(0xeeeeee, WHITE)).not.toBe(0xeeeeee);
  });

  it("answers the same pair the same way every time", () => {
    const first = readableInk(0xd3e3f8, WHITE);
    for (let i = 0; i < 200; i += 1) expect(readableInk(0xd3e3f8, WHITE)).toBe(first);
  });
});
