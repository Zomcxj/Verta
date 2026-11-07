/**
 * A column's width, as the pane lets the user change it.
 *
 * A table read from a file states its own widths, and a reader is usually happy with them - but not
 * always: a column holding a long note is cut off, and a column of numbers is wider than it needs to
 * be. What is changed is the view, not the file: a `.csv` keeps its bytes and a `.xlsx` keeps its
 * own `<col>` elements, so a width dragged here is not written back and comes back on reopening.
 */

/** The narrowest a column may be dragged: less than this and its border cannot be grabbed. */
export const MIN_COLUMN_WIDTH = 32;
/** The widest a column may be dragged, so a stray drag cannot make a sheet unreadable. */
export const MAX_COLUMN_WIDTH = 1200;
/** How close to a column's edge a press counts as grabbing it, in pixels. */
export const RESIZE_GRIP = 5;

/** A dragged width, by column. */
export type ColumnWidths = ReadonlyMap<number, number>;

/** A column's width, with the one the user dragged taking precedence over the file's. */
export function widthOf(column: number, widths: readonly number[], dragged: ColumnWidths): number {
  const dragged_ = dragged.get(column);
  if (dragged_ !== undefined) return dragged_;
  return widths[column] ?? MIN_COLUMN_WIDTH;
}

/** A dragged width brought inside what the pane allows. */
export function clampWidth(width: number): number {
  return Math.round(Math.min(Math.max(width, MIN_COLUMN_WIDTH), MAX_COLUMN_WIDTH));
}

/**
 * The column a press at `x` grabs, when it lands on a column's trailing edge.
 *
 * `offsets` are where each column starts, in the same space as `x`; a press within the grip of a
 * column's right edge is a grab of that column, and anywhere else is not a grab at all.
 */
export function grabbedColumn(
  offsets: readonly number[],
  widths: readonly number[],
  x: number,
  grip = RESIZE_GRIP,
): number | null {
  for (let column = 0; column < offsets.length; column += 1) {
    const edge = offsets[column] + (widths[column] ?? 0);
    if (Math.abs(x - edge) <= grip) return column;
  }
  return null;
}

/**
 * The width a column takes when the pointer has moved to `x`.
 *
 * A drag starts where the pointer went down and moves the column's trailing edge to where the
 * pointer is now, so the width is the difference between them, not the pointer's position.
 */
export function draggedWidth(startWidth: number, startX: number, x: number): number {
  return clampWidth(startWidth + (x - startX));
}

/** The widths a table draws with, the dragged ones laid over the file's. */
export function effectiveWidths(
  columns: number,
  widths: readonly number[],
  dragged: ColumnWidths,
): number[] {
  const out: number[] = [];
  for (let column = 0; column < columns; column += 1) {
    out.push(widthOf(column, widths, dragged));
  }
  return out;
}
