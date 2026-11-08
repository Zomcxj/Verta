/**
 * Where a document's pages end, and how much room to leave between the sheets.
 *
 * A `.docx` is flowed as one column of blocks. A page holds as many whole blocks as fit its text
 * area, and the next page starts at the block that did not fit: a block is never cut in half, which
 * is what keeps a line from being drawn across a page boundary.
 *
 * The gap between pages is made by padding the first block of each page. That is a style and not a
 * node, so paginating never moves the caret: the selection is on text inside those blocks and stays
 * exactly where it was.
 */

/** One block's box, as top and bottom in the paper's own pixels. */
export type BlockExtent = readonly [top: number, bottom: number];

/**
 * The blocks that begin a page, by their position in the body.
 *
 * The first block always begins one. Every other block begins a page when it does not fit in the
 * text area still left on the page being filled. A block taller than a whole page therefore fills
 * one page on its own and overflows it, which is the honest answer for a table that cannot be split.
 */
export function pageStarts(
  extents: readonly BlockExtent[],
  textArea: number,
): number[] {
  if (extents.length === 0 || textArea <= 0) {
    return extents.length === 0 ? [] : [0];
  }
  const starts = [0];
  // Where the page being filled begins, in the same coordinates as the extents.
  let pageTop = extents[0][0];
  for (let at = 1; at < extents.length; at += 1) {
    const [top, bottom] = extents[at];
    if (bottom - pageTop <= textArea) continue;
    starts.push(at);
    pageTop = top;
  }
  return starts;
}

/**
 * The padding to put above each page's first block, so that page `k` begins one whole sheet below
 * page `k - 1`.
 *
 * A page begins at `k` sheet pitches from the top of the paper, and the block that begins it sits
 * at its own flowed position plus whatever padding has already been inserted. The padding is
 * therefore the difference between the two, taken one page at a time. It is never negative: nothing
 * can pull a block back up, and a page that overran its sheet (a block taller than a page) leaves
 * the following sheets to be measured from where the content actually is.
 *
 * Each padding is a whole number of pixels and the count of what has been inserted is kept in those
 * same whole pixels, not in the exact ones. A style states pixels, so a page whose padding came out
 * at 100.49 is given 100; carrying the 0.49 forward anyway would leave every page a fraction below
 * its sheet, and a twenty page document a good ten pixels out by the end.
 */
export function pagePadding(
  starts: readonly number[],
  extents: readonly BlockExtent[],
  pitch: number,
): (readonly [index: number, padding: number])[] {
  if (pitch <= 0) return [];
  const out: [number, number][] = [];
  let inserted = 0;
  for (let page = 1; page < starts.length; page += 1) {
    const at = starts[page];
    const extent = extents[at];
    if (!extent) continue;
    const target = page * pitch - extent[0];
    const padding = Math.round(target - inserted);
    if (padding <= 0) continue;
    out.push([at, padding]);
    inserted += padding;
  }
  return out;
}

/**
 * The block a reader is looking at: the first one whose bottom is still below the top of the view.
 *
 * It is what keeps a page in place under the reader when pagination adds room above it.
 */
export function anchorIndex(
  extents: readonly BlockExtent[],
  viewportTop: number,
): number {
  for (let at = 0; at < extents.length; at += 1) {
    if (extents[at][1] > viewportTop) return at;
  }
  return Math.max(extents.length - 1, 0);
}

/**
 * How many of the pixels a rect reports one of the element's own layout pixels covers.
 *
 * Two scales are on top of each other and they are not the same number: the paper may be drawn
 * shrunk to fit the pane (`zoom`), and the window itself may be zoomed. `offsetHeight` is in layout
 * pixels and a rect is in the window's, so their ratio is what turns one into the other. A pane's
 * scroll offset is in layout pixels, which is why the scroll correction and the extents it is
 * measured from do not divide by the same thing.
 */
export function visualScale(rectHeight: number, offsetHeight: number): number {
  if (!(offsetHeight > 0) || !(rectHeight > 0)) return 1;
  return rectHeight / offsetHeight;
}

/**
 * The padding a page should have, given where its first line is drawn now and where it has to be.
 *
 * A padding is not always additive, so a page can begin a line short of its sheet: the padding is
 * asked for, the flow below it moves by less, and every page under it inherits the shortfall. The
 * answer is therefore measured rather than predicted, and never negative: a page cannot be pulled
 * back up by a style on a block.
 */
export function pagePaddingToward(current: number, inkTop: number, target: number): number {
  return Math.max(0, current + Math.round(target - inkTop));
}

/**
 * How far to scroll to keep a block where it was, after everything above it moved.
 *
 * Both numbers are rect tops, which are in the window's pixels, and a scroll offset is in layout
 * pixels, so the difference is divided by the window's scale.
 */
export function scrollAdjustment(
  beforeTop: number,
  afterTop: number,
  scale: number,
): number {
  if (scale <= 0) return 0;
  return (afterTop - beforeTop) / scale;
}
