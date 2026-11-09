import { describe, expect, it } from "vitest";
import {
  anchorIndex,
  type BlockExtent,
  pageRanges,
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

describe("which blocks each page holds", () => {
  it("gives every page the blocks between it and the next", () => {
    expect(pageRanges([0, 4, 8], 9)).toEqual([
      [0, 4],
      [4, 8],
      [8, 9],
    ]);
  });

  it("gives the last page everything that is left", () => {
    // A page begins at a block, so the tail of the document belongs to the page that begins last -
    // however many blocks that is.
    expect(pageRanges([0, 2], 5)).toEqual([
      [0, 2],
      [2, 5],
    ]);
    expect(pageRanges([0], 3)).toEqual([[0, 3]]);
  });

  it("holds nothing at all for a document with no blocks", () => {
    expect(pageRanges([], 0)).toEqual([]);
  });

  it("never leaves a page empty", () => {
    // The range of a page starts at a block that exists, so every page has something on it: a page
    // with nothing in it is a blank sheet the reader has to scroll past.
    const extents = stack(0, 25, 9);
    const ranges = pageRanges(pageStarts(extents, 100), extents.length);
    expect(ranges).toEqual([
      [0, 4],
      [4, 8],
      [8, 9],
    ]);
    expect(ranges.every(([from, to]) => to > from)).toBe(true);
    expect(ranges[0][0]).toBe(0);
    expect(ranges[ranges.length - 1][1]).toBe(extents.length);
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

