import { describe, expect, it } from "vitest";

import { DARKEST_FAINT, FAINT_FLOOR, faintAlpha } from "./faintInk";

/**
 * `\e[2m` on a light paper.
 *
 * Reported as "还是白底灰色" over opencode's screen. Ghostty's faint is a fixed 50% mix toward the
 * background, which is a dark-paper idiom; on a white page it turns near-black ink into #8d8d8d
 * (3.32:1) and, when the ink was already a muted grey, into #c2c2c2 (1.78:1). The samples that
 * produced those numbers are in the module's own header.
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
  const [hi, lo] = luminance(a) > luminance(b) ? [luminance(a), luminance(b)] : [luminance(b), luminance(a)];
  return (hi + 0.05) / (lo + 0.05);
}

/** The colour the renderer draws: ink mixed over paper, in the framebuffer's own 8-bit space. */
function mixed(ink: number, paper: number, alpha: number): number {
  const from = channels(ink);
  const onto = channels(paper);
  const [r, g, b] = from.map((value, i) => Math.round(onto[i] + (value - onto[i]) * alpha));
  return (r << 16) | (g << 8) | b;
}

const WHITE = 0xffffff;
const NEAR_BLACK = 0x1a1a1a;
const DARK_PAPER = 0x1a1a1a;

/** The contrast a cell actually shows at the alpha this function returned. */
const drawn = (ink: number, paper: number) => contrast(mixed(ink, paper, faintAlpha(ink, paper)), paper);

describe("how far faint ink may be dimmed", () => {
  it("dims a light paper's body ink only as far as the floor allows", () => {
    const alpha = faintAlpha(NEAR_BLACK, WHITE);
    // Half of `\e[2m`'s old 50% - measured 1.82:1 before this and 3.32:1 for the same ink at 50%.
    expect(alpha).toBeGreaterThan(DARKEST_FAINT);
    expect(alpha).toBeLessThan(1);
    expect(contrast(mixed(NEAR_BLACK, WHITE, alpha), WHITE)).toBeGreaterThanOrEqual(FAINT_FLOOR);
    // The step before it does not clear the floor, so no dimming was left on the table.
    expect(contrast(mixed(NEAR_BLACK, WHITE, alpha - 0.02), WHITE)).toBeLessThan(FAINT_FLOOR);
    // And it is still visibly secondary: a third of the contrast the ink itself carries.
    expect(drawn(NEAR_BLACK, WHITE)).toBeLessThan(contrast(NEAR_BLACK, WHITE) / 3);
  });

  it("will not dim a colour that is already muted", () => {
    // opencode's secondary text: #808080 is 3.95:1 on white, so every bit of dimming only moves it
    // toward the page. Before, 50% of it was #c0c0c0 at 1.82:1 - a grey page.
    expect(faintAlpha(0x808080, WHITE)).toBe(1);
    expect(drawn(0x808080, WHITE)).toBeCloseTo(3.95, 1);
  });

  it("draws an unreadable colour at full strength rather than halfway to the page", () => {
    // Nothing can make #f8f8f8 legible on white, but dimming it further is strictly worse.
    expect(faintAlpha(0xf8f8f8, WHITE)).toBe(1);
    expect(faintAlpha(WHITE, WHITE)).toBe(1);
    // The same on a dark paper: a mid grey that cannot reach the floor is left alone.
    expect(faintAlpha(0x808080, DARK_PAPER)).toBe(1);
  });

  it("leaves a dark paper on the 50% it has always had", () => {
    // The dark theme is not what was reported and must not shift. Its ink and paper are #f7f7f7 on
    // #141414, which is already 5.06:1 halfway to the page, so the step search stops at the first
    // step - the same 0.5 the fixed mix used.
    expect(faintAlpha(0xf7f7f7, 0x141414)).toBe(DARKEST_FAINT);
    // What does move there is a faint over an ink that was muted to begin with: 2.08:1 is the same
    // unreadable grey the light paper had, and it is raised to the ink's own 4.54:1.
    expect(faintAlpha(0x808080, 0x141414)).toBeCloseTo(0.98, 2);
    expect(drawn(0x808080, 0x141414)).toBeGreaterThanOrEqual(FAINT_FLOOR);
  });

  it("never makes a cell harder to read than the fixed 50% did", () => {
    const papers = [WHITE, 0xfaf9f5, NEAR_BLACK, 0x101010, 0x2b2b2b];
    const inks = [0x000000, 0x1f1e1d, 0x3d3a2f, 0x808080, 0xa0a0a0, 0xe6e6e6, 0xf8f8f8, 0xee7948];
    const worse: string[] = [];
    for (const paper of papers) {
      for (const ink of inks) {
        const before = contrast(mixed(ink, paper, DARKEST_FAINT), paper);
        const after = drawn(ink, paper);
        if (after < before - 1e-9) {
          worse.push(`${ink.toString(16)} on ${paper.toString(16)}: ${before.toFixed(2)} -> ${after.toFixed(2)}`);
        }
      }
    }
    expect(worse).toEqual([]);
  });

  it("answers the same pair the same way every time", () => {
    const first = faintAlpha(0x1f1e1d, 0xfaf9f5);
    for (let i = 0; i < 100; i += 1) expect(faintAlpha(0x1f1e1d, 0xfaf9f5)).toBe(first);
  });
});
