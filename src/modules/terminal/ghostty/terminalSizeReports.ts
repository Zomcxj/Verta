/**
 * Answers the size queries a full-screen TUI sends to learn how much room it
 * has in real pixels.
 *
 * A TUI that draws a picture has to turn the picture's pixel size into cells by
 * dividing by the cell size, and the numbers only exist if the terminal hands
 * them over. Silence is not read as "unknown, guess something reasonable": a
 * program that cannot size the picture tends to drop it and leave the space
 * blank, which is what opencode does with an image attached to a message. The
 * terminal is the only party that knows its own cell size, so the answer has to
 * come from here.
 *
 * The queries arrive inside the byte stream from the PTY, mixed in with the
 * drawing commands, and a query can land across two reads, so the scan keeps a
 * few trailing characters between calls.
 */

/** Cell metrics, in physical pixels, of the terminal being answered. */
export interface TerminalPixelGeometry {
  /** Text area width in cells. */
  readonly cols: number;
  /** Text area height in cells. */
  readonly rows: number;
  /** Width of one cell in physical pixels. */
  readonly cellWidth: number;
  /** Height of one cell in physical pixels. */
  readonly cellHeight: number;
  /** Left edge of the text area, in physical pixels. */
  readonly originX: number;
  /** Top edge of the text area, in physical pixels. */
  readonly originY: number;
}

/**
 * Every query starts with `\u001b[1`, so a chunk without that prefix cannot
 * contain one. Whole-screen repaints are the common case and they are large,
 * so the cheap rejection is worth having before touching the regular
 * expression.
 */
const MAYBE_QUERY = "\u001b[1";

/** `CSI Ps t` size reports: 13 origin, 14/15 size, 16 cell, 18/19 size in cells. */
const SIZE_QUERY = /\u001b\[(13|14|15|16|18|19)(?:;(\d+))?t/gu;

/**
 * Characters held back between calls. Long enough to cover the start of any
 * query above, short enough that a query already matched cannot be matched a
 * second time: the shortest query here is five characters.
 */
const CARRY = 4;

/**
 * `CSI 14 ; 2 t` asks for the text area in cells rather than in pixels; every
 * other supported query reports pixels.
 */
const CELL_UNIT = "2";

function report(query: string, units: string | undefined, geometry: TerminalPixelGeometry): string {
  const { cols, rows, cellWidth, cellHeight, originX, originY } = geometry;
  const widthPixels = Math.round(cols * cellWidth);
  const heightPixels = Math.round(rows * cellHeight);
  const inCells = units === CELL_UNIT;
  switch (query) {
    // Text area position.
    case "13":
      return `\u001b[3;${Math.round(originY)};${Math.round(originX)}t`;
    // Text area size, in pixels unless cells were asked for.
    case "14":
      return inCells
        ? `\u001b[4;${rows};${cols}t`
        : `\u001b[4;${heightPixels};${widthPixels}t`;
    // Screen size in pixels: this window has one text area and no chrome.
    case "15":
      return `\u001b[5;${heightPixels};${widthPixels}t`;
    // One cell, in pixels.
    case "16":
      return `\u001b[6;${Math.round(cellHeight)};${Math.round(cellWidth)}t`;
    // Text area size in cells.
    case "18":
      return `\u001b[8;${rows};${cols}t`;
    // Screen size in cells.
    case "19":
      return `\u001b[9;${rows};${cols}t`;
    default:
      return "";
  }
}

export class TerminalSizeReports {
  private carry = "";

  /**
   * Returns the replies owed for this chunk, or null when the chunk held no
   * query. Callers without metrics to report should not call this at all,
   * since a wrong answer places a picture in the wrong place, while no answer
   * only loses it.
   */
  observe(chunk: string, geometry: TerminalPixelGeometry): string | null {
    const text = this.carry + chunk;
    this.carry = text.length > CARRY ? text.slice(-CARRY) : text;
    if (!text.includes(MAYBE_QUERY)) return null;
    let replies = "";
    for (const match of text.matchAll(SIZE_QUERY)) {
      replies += report(match[1], match[2], geometry);
    }
    return replies === "" ? null : replies;
  }

  /** Drops the held-back characters, for a session that is being reused. */
  reset(): void {
    this.carry = "";
  }
}