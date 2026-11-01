/**
 * The two numbers a changed-file row shows, or `null` when the row should show none.
 *
 * `0` is shown rather than hidden: "13 added, none removed" is a fact about the change, and a row
 * that silently drops the `-0` reads as if the count were unknown. The pair always arrives
 * together, so half of it is treated as no answer at all.
 */
export function lineCounts(
  added: number | null,
  removed: number | null,
): { added: string; removed: string } | null {
  if (added === null || removed === null) return null;
  return { added: `+${added}`, removed: `-${removed}` };
}
