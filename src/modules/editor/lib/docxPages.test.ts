import { describe, expect, it } from "vitest";
import {
  anchorIndex,
  type BlockExtent,
  pagePadding,
  pagePaddingToward,
  pageStarts,
  scrollAdjustment,
  visualScale,
} from "./docxPages";

/** Blocks stacked from `top`, each `height` tall, with no gap between them. */
function stack(top: number, height: number, count: number): BlockExtent[] {
  return Array.from({ length: count }, (_, at) => {
    const start = top + at * height;
    return [start, start + height] as const;
  });
}

describe("which blocks begin a page", () => {
  it("starts a page at the first block that does not fit", () => {
    // A text area of 100 holds four 25 tall blocks; the fifth begins the next page.
    expect(pageStarts(stack(0, 25, 9), 100)).toEqual([0, 4, 8]);
  });

  it("breaks above a block rather than through it", () => {
    // Three blocks of 40: 120 does not fit 100, so the third begins a page even though it would
    // half fit - a block is never cut in half.
    expect(pageStarts(stack(0, 40, 3), 100)).toEqual([0, 2]);
  });

  it("gives a block taller than a page one page of its own", () => {
    const extents: BlockExtent[] = [
      [0, 10],
      [10, 260],
      [260, 270],
    ];
    expect(pageStarts(extents, 100)).toEqual([0, 1, 2]);
  });

  it("says nothing about a document with no blocks, and never divides by no text area", () => {
    expect(pageStarts([], 100)).toEqual([]);
    expect(pageStarts(stack(0, 10, 3), 0)).toEqual([0]);
  });
});

describe("how much room to leave between sheets", () => {
  it("pads the page so it begins one whole sheet below the one before", () => {
    // Two pages of 100 with a 20 gap between them: page two begins at 120.
    const extents = stack(0, 50, 2);
    const starts = [0, 1];
    const padding = pagePadding(starts, extents, 120);
    // The second block sits at 50 and must sit at 120, so it takes 70 of padding.
    expect(padding).toEqual([[1, 70]]);
  });

  it("accounts for the padding it has already inserted", () => {
    // Three pages: each target is measured from the paper's top, so the third block's padding is
    // its target less what the second one already took.
    const extents: BlockExtent[] = [
      [0, 50],
      [50, 100],
      [100, 150],
    ];
    const starts = [0, 1, 2];
    const padding = pagePadding(starts, extents, 120);
    // Page two: 120 - 50 = 70 inserted. Page three: 240 - 100 = 140 wanted, 70 already in, so 70.
    expect(padding).toEqual([
      [1, 70],
      [2, 70],
    ]);
  });

  it("pads nothing when the document is one page", () => {
    expect(pagePadding([0], stack(0, 20, 4), 120)).toEqual([]);
  });

  it("never asks to pull a block back up", () => {
    // A page that overran its sheet leaves the next page already too far down; inserting a negative
    // padding would move content, which a style on a block cannot honestly do.
    const extents: BlockExtent[] = [
      [0, 400],
      [400, 420],
    ];
    expect(pagePadding([0, 1], extents, 120)).toEqual([]);
  });

  it("counts the padding it gave, not the padding it wanted", () => {
    // A style states whole pixels, so a page that wanted 100.49 gets 100. Adding the exact 100.49 to
    // the running total anyway leaves every page below its sheet: over twenty pages of this shape
    // the last one is nine pixels out, which is a visible white band under the text.
    const height = 100;
    const extents: BlockExtent[] = Array.from({ length: 160 }, (_, at) => {
      const top = at * height;
      return [top, top + height] as const;
    });
    const starts = pageStarts(extents, 700);
    const pitch = 700 + 100.49;
    const padding = new Map(pagePadding(starts, extents, pitch));
    let inserted = 0;
    let worst = 0;
    for (let page = 1; page < starts.length; page += 1) {
      const at = starts[page];
      // What the pane writes into the style, which is what settles the layout.
      inserted += Math.round(padding.get(at) ?? 0);
      worst = Math.max(worst, Math.abs(extents[at][0] + inserted - page * pitch));
    }
    expect(starts.length).toBeGreaterThan(15);
    expect(worst).toBeLessThanOrEqual(1);
  });

  it("says nothing for a paper with no height", () => {
    expect(pagePadding([0, 1], stack(0, 50, 2), 0)).toEqual([]);
  });
});

describe("what the reader is looking at", () => {
  it("is the first block still below the top of the view", () => {
    const extents = stack(0, 25, 6);
    expect(anchorIndex(extents, 0)).toBe(0);
    expect(anchorIndex(extents, 30)).toBe(1);
    expect(anchorIndex(extents, 100)).toBe(4);
  });

  it("is the last block when the view is past the end of the document", () => {
    expect(anchorIndex(stack(0, 25, 3), 10_000)).toBe(2);
    expect(anchorIndex([], 0)).toBe(0);
  });
});

describe("keeping that block where it was", () => {
  it("scrolls by how far the block moved, in the pane's own pixels", () => {
    // The paper is drawn at half scale, so 70 paper pixels are 140 pane pixels.
    expect(scrollAdjustment(50, 120, 0.5)).toBe(140);
    expect(scrollAdjustment(120, 50, 1)).toBe(-70);
  });

  it("moves nothing when nothing moved, or when the scale is not known yet", () => {
    expect(scrollAdjustment(50, 50, 0.8)).toBe(0);
    expect(scrollAdjustment(50, 120, 0)).toBe(0);
  });
});

describe("the scale a rect is drawn at", () => {
  it("is the ratio of what is drawn to what is laid out", () => {
    // A page stated at 8026 layout pixels and drawn 7624 tall is drawn at 95 percent, which is what
    // a zoomed window does to everything inside it.
    expect(visualScale(7624.44, 8026)).toBeCloseTo(0.95, 4);
    expect(visualScale(929, 978)).toBeCloseTo(0.9499, 4);
  });

  it("is one for an element drawn at its own size", () => {
    expect(visualScale(500, 500)).toBe(1);
  });

  it("is one rather than a division by zero before the pane has been measured", () => {
    // A hidden pane reports nothing for either number, and an infinite scale would send the scroll
    // to the end of the document.
    expect(visualScale(0, 8026)).toBe(1);
    expect(visualScale(7624, 0)).toBe(1);
  });
});

describe("putting a page back on its sheet", () => {
  it("does not touch a page that is already where it should be", () => {
    expect(pagePaddingToward(300, 1150.5, 1150.5)).toBe(300);
  });

  it("gives a page back what it fell short by", () => {
    // The shape of it, from a real thesis: a page whose first block was collapsing its own margins
    // came out 21 high, because giving it a padding stopped the collapse and the move was not
    // additive. Asked for one sheet at 1150.5 it sat at 1129.9, so its padding grows by 21.
    expect(pagePaddingToward(277, 1129.9, 1150.5)).toBe(298);
    // And the other way: a page that landed low has its padding taken back.
    expect(pagePaddingToward(300, 1170, 1150.5)).toBe(281);
  });

  it("never asks for a padding below nothing", () => {
    // A page cannot be pulled up by a style on a block, so a page that is too low keeps no padding.
    expect(pagePaddingToward(20, 1300, 1150.5)).toBe(0);
    expect(pagePaddingToward(0, 1300, 1150.5)).toBe(0);
  });
});
