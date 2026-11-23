import { describe, expect, it } from "vitest";

import { isBlockElement } from "./gpu/builtin/blockElements";
import { INK_FLOOR, INVISIBLE_INK, readableInk } from "./readableInk";

/**
 * A picture drawn as half blocks must not be run through the ink rescue.
 *
 * opencode draws an attached picture with U+2580: the cell's foreground paints the upper half and
 * its background the lower half. A photograph's neighbouring rows are a percent or two apart, so
 * almost every such pair is below `INVISIBLE_INK` - and the rescue then pushes the upper half
 * toward black or white until it clears `INK_FLOOR`. The picture stops being a picture: measured on
 * a screenshot of the running app, 39% of the cells' two halves came out between 4.45:1 and 4.9:1
 * (the floor and nothing above it) and 23% of cells held a pure black or white half.
 *
 * The GPU renderer already draws cell-exact shapes without contrast (`GLYPH_ENTRY_FLAG_EXACT`).
 * The WebGL renderer applies the rescue to every cell, because its atlas entry has no `exact` flag
 * to ask. This file holds the two facts the fix has to keep: which codepoints are a program's own
 * drawing, and what the rescue does to a photograph's ink.
 */

/** The packed colour the rescue would draw for `ink` on `paper`. */
function rescued(ink: number, paper: number): number {
  return readableInk(ink, paper);
}

/** WCAG contrast, as the rescue measures it. */
function contrast(a: number, b: number): number {
  const luminance = (color: number) => {
    const [r, g, b2] = [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff].map((value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [hi, lo] = luminance(a) > luminance(b) ? [luminance(a), luminance(b)] : [luminance(b), luminance(a)];
  return (hi + 0.05) / (lo + 0.05);
}

describe("a mosaic picture is not text", () => {
  it("draws the half block the picture is made of", () => {
    // U+2580 UPPER HALF BLOCK, and its neighbours in the block range. `isBlockElement` is the test
    // `BuiltinGlyphs` uses to decide a codepoint is drawn from the cell geometry rather than a font.
    for (const codepoint of [0x2580, 0x2584, 0x2588, 0x2591, 0x2596]) {
      expect(isBlockElement(codepoint), `${codepoint.toString(16)} is a program's own drawing`).toBe(true);
    }
  });

  it("is broken by the rescue: a photograph's two halves are a percent apart", () => {
    // Two rows of one picture, taken from a real one: a blue-grey and a warmer grey. Both are
    // ordinary photograph colours and both are below the threshold the rescue looks for.
    const pairs = [
      [0x6a7a8a, 0x6e7e8e],
      [0xc0b8a8, 0xc4bcac],
      [0x3a3a3a, 0x3e3e3e],
    ] as const;
    for (const [top, bottom] of pairs) {
      expect(contrast(top, bottom), `${top.toString(16)} vs ${bottom.toString(16)}`).toBeLessThan(INVISIBLE_INK);
      // What the rescue would draw instead of the top half: a different colour, always.
      expect(rescued(top, bottom)).not.toBe(top);
    }
  });

  it("pushes a photograph's half to an extreme and stops there", () => {
    // The rescue walks toward black or white until it clears the floor. On a mid-dark paper even
    // pure white cannot clear it (4.17:1 here), so the walk reaches the extreme and keeps it: the
    // upper half is drawn pure white whatever colour it held.
    const ink = rescued(0x6a7a8a, 0x6e7e8e);
    expect(ink).toBe(0xffffff);
    // The same paper's ceiling is below the floor, which is why no step of the walk could pass.
    expect(contrast(0xffffff, 0x6e7e8e)).toBeLessThan(INK_FLOOR);
  });

  it("drags a photograph's half to the floor, which is the whole defect", () => {
    // The colour is not thrown away - the mix keeps its hue - but its *value* is pushed until it
    // clears `INK_FLOOR` and then stops. On the screen that is a picture whose shading is gone: every
    // cell sits on the same contrast against the cell below it, whatever the photograph was doing.
    const ink = rescued(0xc0b8a8, 0xc4bcac);
    const drawn = contrast(ink, 0xc4bcac);
    expect(drawn).toBeGreaterThanOrEqual(INK_FLOOR);
    expect(drawn).toBeLessThan(INK_FLOOR + 0.5);
    // The original was a percent or two from its paper; the rescue moved it a long way.
    expect(contrast(0xc0b8a8, 0xc4bcac)).toBeLessThan(1.1);
  });

  it("leaves a cell that is already legible alone, which is why the fix is a guard not a removal", () => {
    // The rescue has to keep working for text: this is the case it was written for.
    const rescuedText = rescued(0xeeeeee, 0xffffff);
    expect(rescuedText).not.toBe(0xeeeeee);
    expect(contrast(rescuedText, 0xffffff)).toBeGreaterThanOrEqual(INK_FLOOR);
  });
});
