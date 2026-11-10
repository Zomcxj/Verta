/**
 * Finds the pictures an agent asked the terminal to show.
 *
 * A TUI has no way to hand over pixels, so when a message carries an image it
 * prints the filename and reserves space above it: either blank, or filled with
 * a mosaic of block characters standing in for the picture. Reading that
 * arrangement back out of the screen is what lets the real image be drawn in the
 * space that was already reserved for it.
 *
 * The mosaic is what this uses to size the picture. A message that reserved
 * nothing gets nothing drawn, which is the honest outcome: without a reserved
 * area there is nowhere the picture can go that would not cover text.
 */

import { IMAGE_EXTENSIONS } from "@/lib/imageFormats";

/** One visible row: the absolute line it shows, and its cells by column. */
export interface ScreenRow {
  readonly line: number;
  readonly cells: readonly string[];
}

export interface ImageReference {
  /** The filename the terminal printed. */
  readonly name: string;
  /** Absolute line of the row that printed it. */
  readonly labelLine: number;
  /** Absolute lines the picture may occupy, both ends included. */
  readonly topLine: number;
  readonly bottomLine: number;
  /** Columns the picture may occupy, both ends included. */
  readonly leftColumn: number;
  readonly rightColumn: number;
}

/**
 * Block Elements. A mosaic is built out of these, and they are also what a
 * progress bar or a scrollbar accent uses, which is why a run of them has to be
 * adjacent to the filename before it is treated as a picture.
 */
const BLOCK = /[\u2580-\u259f]/;

const IMAGE_EXTENSION = new RegExp(`\\.(?:${IMAGE_EXTENSIONS.join("|")})$`, "i");

/** The badge opencode prints in front of a filename. */
const FILE_BADGE = "file";

/**
 * Empty columns that still belong to the same picture. A mosaic leaves gaps
 * where the picture is transparent, and those gaps are narrow; the terminal's
 * own chrome, such as the accent bar down the right edge, is far away.
 */
const BAND_GAP = 6;

/** Rows between the filename and the mosaic, such as opencode's own label. */
const MAX_LEAD = 6;

/** Rows searched above the filename. */
const MAX_WINDOW = 24;

/** Rows one picture may occupy. Keeps two pictures from merging into one. */
const MAX_SPAN = 14;

/**
 * The name a row prints, if it prints one.
 *
 * The badge has to be the first thing on the row's own content, after the
 * message border: that is where opencode puts it, and requiring it is what
 * keeps prose that merely mentions a file from being read as an attachment.
 *
 * The name is everything after the badge up to an extension, or the whole rest
 * of the row when there is no extension to stop at. opencode names an image
 * pasted from the clipboard `clipboard` rather than after a file, so an
 * extension is not something to insist on.
 */
export function nameInRow(text: string): { name: string; column: number } | null {
  const start = contentStart(text);
  if (!text.startsWith(FILE_BADGE, start)) return null;
  const after = start + FILE_BADGE.length;
  const next = text[after];
  if (next !== undefined && next !== " ") return null;
  let column = after;
  while (text[column] === " ") column += 1;
  const tail = text.slice(column).trimEnd();
  if (!tail || tail.length > MAX_NAME) return null;
  const extension = IMAGE_EXTENSION.exec(tail);
  const name = extension
    ? tail.slice(0, extension.index + extension[0].length)
    : tail;
  if (name.includes("\u0000")) return null;
  return { name, column };
}

/** Longest name taken from a row, so a run-on of text is not mistaken for one. */
const MAX_NAME = 160;

/** Box drawing characters, used for message borders. */
const BORDER = /[\u2500-\u257f]/;

function contentStart(text: string): number {
  let index = 0;
  while (index < text.length && (text[index] === " " || BORDER.test(text[index]))) {
    index += 1;
  }
  return index;
}

/**
 * How far back each row has to look among attachments with its own name,
 * counting from the bottom of the screen. The newest attachment of a repeated
 * name is the one lowest on the screen, so a row that shares its name with
 * nothing below it ranks zero. Images pasted from the clipboard are all called
 * `clipboard`, which is what makes this necessary.
 */
export function nameRanks(references: readonly ImageReference[]): number[] {
  const ranks = new Array<number>(references.length);
  const seen = new Map<string, number>();
  for (let index = references.length - 1; index >= 0; index -= 1) {
    const name = references[index].name;
    const rank = seen.get(name) ?? 0;
    ranks[index] = rank;
    seen.set(name, rank + 1);
  }
  return ranks;
}

export function findImageReferences(rows: readonly ScreenRow[]): ImageReference[] {
  const references: ImageReference[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const named = nameInRow(rows[index].cells.join(""));
    if (!named || named.name.length === 0) continue;
    const box = pictureAbove(rows, index);
    if (!box) continue;
    references.push({
      name: named.name,
      labelLine: rows[index].line,
      topLine: rows[box.top].line,
      bottomLine: rows[box.bottom].line,
      leftColumn: box.left,
      rightColumn: box.right,
    });
  }
  return references;
}

/**
 * The picture sitting above a filename: the band of columns it occupies, and the
 * rows carrying that band.
 */
function pictureAbove(
  rows: readonly ScreenRow[],
  from: number,
): { top: number; bottom: number; left: number; right: number } | null {
  const first = Math.max(0, from - MAX_WINDOW);
  const band = widestBand(rows, first, from);
  if (!band) return null;

  // opencode puts its label and a blank line or two between the picture and the
  // filename, so the nearest row carrying the band is looked for rather than
  // the one immediately above.
  let bottom = -1;
  for (let index = from - 1; index >= first && from - index <= MAX_LEAD; index -= 1) {
    // Another picture's filename means this one ended above it.
    if (nameInRow(rows[index].cells.join("")) !== null) break;
    if (carries(rows[index], band)) {
      bottom = index;
      break;
    }
  }
  if (bottom < 0) return null;

  let top = bottom;
  for (let index = bottom - 1; index >= first && bottom - index < MAX_SPAN; index -= 1) {
    if (!carries(rows[index], band)) break;
    top = index;
  }
  // The first pass finds the picture among the things sharing its rows; this one
  // measures it against nothing but the rows it turned out to occupy.
  const extent = refineBand(rows, top, bottom, band) ?? band;
  return { top, bottom, left: extent.left, right: extent.right };
}

function refineBand(
  rows: readonly ScreenRow[],
  top: number,
  bottom: number,
  coarse: { left: number; right: number },
): { left: number; right: number } | null {
  const occupied = new Set<number>();
  for (let index = top; index <= bottom; index += 1) {
    const cells = rows[index].cells;
    for (let column = coarse.left; column <= coarse.right; column += 1) {
      if (BLOCK.test(cells[column] ?? " ")) occupied.add(column);
    }
  }
  return widestBandOf(occupied);
}

/**
 * The widest group of occupied columns. Grouping by proximity is what separates
 * the picture from chrome that shares the screen with it: the picture's own gaps
 * are narrow, while anything else is a long way off.
 */
function widestBand(
  rows: readonly ScreenRow[],
  first: number,
  last: number,
): { left: number; right: number } | null {
  const occupied = new Set<number>();
  for (let index = first; index < last; index += 1) {
    const cells = rows[index].cells;
    for (let column = 0; column < cells.length; column += 1) {
      if (BLOCK.test(cells[column])) occupied.add(column);
    }
  }
  return widestBandOf(occupied);
}

function widestBandOf(occupied: ReadonlySet<number>): { left: number; right: number } | null {
  if (occupied.size === 0) return null;
  const sorted = [...occupied].sort((a, b) => a - b);
  let best: { left: number; right: number } | null = null;
  let start = sorted[0];
  for (let index = 1; index <= sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (current !== undefined && current - previous <= BAND_GAP) continue;
    const candidate = { left: start, right: previous };
    if (!best || candidate.right - candidate.left > best.right - best.left) {
      best = candidate;
    }
    if (current === undefined) break;
    start = current;
  }
  return best;
}

function carries(row: ScreenRow, band: { left: number; right: number }): boolean {
  for (let column = band.left; column <= band.right; column += 1) {
    if (BLOCK.test(row.cells[column] ?? " ")) return true;
  }
  return false;
}