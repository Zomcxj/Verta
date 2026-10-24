/**
 * Where a terminal's hidden input belongs: on the cell the cursor is in.
 *
 * The input is a `<textarea>` that is invisible and one pixel wide, kept only as the target the
 * browser and the IME talk to. Every IME places its candidate window next to the focused element,
 * so pinning that element to the pane's top-left corner, which is what both surfaces used to do,
 * pinned the candidate list there as well: typing in the middle of a session opened the candidates
 * at the top of the pane instead of under the cursor. A cell-sized target on the cursor cell is
 * what the IME needs to open them where the user is looking.
 */
export function inputPlacement(
  cursor: { readonly x: number; readonly y: number },
  cell: { readonly width: number; readonly height: number },
  cols: number,
  rows: number,
): {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
} {
  const lastColumn = Math.max(cols - 1, 0);
  const lastRow = Math.max(rows - 1, 0);
  const column = Number.isFinite(cursor.x)
    ? Math.min(Math.max(Math.round(cursor.x), 0), lastColumn)
    : 0;
  const row = Number.isFinite(cursor.y)
    ? Math.min(Math.max(Math.round(cursor.y), 0), lastRow)
    : 0;
  // A cell of zero would leave the element with no box at all, which some IMEs will not open on.
  const width = cell.width > 0 ? cell.width : 1;
  const height = cell.height > 0 ? cell.height : 1;
  return { left: column * width, top: row * height, width, height };
}