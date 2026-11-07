import type { XlsxMerge, XlsxTrack } from "@/lib/native";

/**
 * A spreadsheet grid's arithmetic, kept out of the component so it can be tested on its own.
 *
 * Nothing here draws: it turns the column sizes and the merge list a workbook declares into the
 * offsets, widths and covered cells the pane needs, which is where the mistakes live.
 */

/**
 * How a cell's value sits in its column, when its style does not say.
 *
 * The sheet's own alignment wins; otherwise a number goes to the right of its column, as a
 * spreadsheet puts it, a boolean or an error to the middle, and text to the left.
 */
export function cellJustify(kind: string, align: string | null): "left" | "center" | "right" {
  if (align === "left" || align === "center" || align === "right") return align;
  if (kind === "number") return "right";
  if (kind === "boolean" || kind === "error") return "center";
  return "left";
}

/** A column's name, as a spreadsheet names it: 0 is `A`, 25 is `Z`, 26 is `AA`. */
export function columnLabel(index: number): string {
  let remaining = index;
  let label = "";
  // Bijective base 26: there is no zero digit, so the count is off by one at every step.
  do {
    label = String.fromCharCode(65 + (remaining % 26)) + label;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return label;
}

/** The width of every column: what the file states, and the pane's own for the rest. */
export function columnWidths(
  columns: number,
  sizes: readonly XlsxTrack[],
  fallback: number,
): number[] {
  const widths = new Array<number>(Math.max(columns, 0)).fill(fallback);
  for (const size of sizes) {
    // A hidden column is stated as zero width and stays that way.
    if (size.index >= 0 && size.index < widths.length) widths[size.index] = size.size;
  }
  return widths;
}

/** Where each column starts, from its widths. */
export function columnOffsets(widths: readonly number[]): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const width of widths) {
    offsets.push(at);
    at += width;
  }
  return offsets;
}

/** The total of a list of lengths. */
export function total(lengths: readonly number[]): number {
  let sum = 0;
  for (const length of lengths) sum += length;
  return sum;
}

/**
 * A merge larger than this is not expanded. A whole-column merge is written as one region of a
 * million rows, and walking it to mark every covered cell would be the pane's whole budget.
 */
const MAX_MERGE_CELLS = 10_000;

/** A cell's key in the merge map. */
function key(row: number, column: number): string {
  return `${row}:${column}`;
}

/**
 * Every cell a merge covers, by cell, so a cell can find the region it belongs to.
 *
 * A region's own corner is in the map too: that is the cell that draws the whole region, and every
 * other entry is a cell not to draw.
 */
export function mergeCells(merges: readonly XlsxMerge[]): Map<string, XlsxMerge> {
  const cells = new Map<string, XlsxMerge>();
  for (const merge of merges) {
    if (merge.rowSpan * merge.columnSpan > MAX_MERGE_CELLS) continue;
    for (let row = merge.row; row < merge.row + merge.rowSpan; row += 1) {
      for (let column = merge.column; column < merge.column + merge.columnSpan; column += 1) {
        cells.set(key(row, column), merge);
      }
    }
  }
  return cells;
}

/** Whether a cell draws its region, rather than being covered by one. */
export function draws(merge: XlsxMerge | undefined, row: number, column: number): boolean {
  if (!merge) return true;
  return merge.row === row && merge.column === column;
}

/**
 * The columns to draw for a scroll position and a viewport width.
 *
 * A grid of a thousand columns draws the dozen on the screen; this is what says which dozen, with
 * a few either side so a scroll does not arrive at an empty strip.
 */
export function windowOf(
  offsets: readonly number[],
  widths: readonly number[],
  scrollLeft: number,
  viewport: number,
  overscan: number,
): { start: number; count: number } {
  if (offsets.length === 0) return { start: 0, count: 0 };
  const right = scrollLeft + Math.max(viewport, 0);
  let first = offsets.length - 1;
  for (let index = 0; index < offsets.length; index += 1) {
    if (offsets[index] + widths[index] > scrollLeft) {
      first = index;
      break;
    }
  }
  let last = first;
  for (let index = first; index < offsets.length; index += 1) {
    if (offsets[index] >= right) break;
    last = index;
  }
  const start = Math.max(first - overscan, 0);
  const end = Math.min(last + overscan, offsets.length - 1);
  return { start, count: end - start + 1 };
}
