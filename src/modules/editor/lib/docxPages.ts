/**
 * Where a document's pages end, and which blocks each of them holds.
 *
 * A `.docx` is flowed as one column of blocks. A page holds as many whole blocks as fit its text
 * area, and the next page starts at the block that did not fit: a block is never cut in half, which
 * is what keeps a line from being drawn across a page boundary.
 *
 * The pages are real sheets and they hold their own blocks, so what this module answers is which
 * block belongs to which page. The gap between two sheets is a gap between two elements rather than
 * a padding on the first block of a page, and pagination therefore moves a node - which is why the
 * caret is carried across it by block and offset (see `docxBodyDom`).
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
 * The blocks each page holds, as a range of positions in the document.
 *
 * The last page holds everything from its first block on: the blocks that were measured are all
 * there is, and a page that begins at the end of them holds nothing.
 */
export function pageRanges(
  starts: readonly number[],
  count: number,
): (readonly [from: number, to: number])[] {
  return starts.map((from, page) => [from, starts[page + 1] ?? count] as const);
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

