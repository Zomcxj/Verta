/**
 * The two numbers a changed-file row shows, or `null` when the row should show none.
 *
 * `0` is shown rather than hidden: "13 added, none removed" is a fact about the change, and a row
 * that silently drops the `−0` reads as if the count were unknown. The pair always arrives
 * together, so half of it is treated as no answer at all.
 *
 * The minus is U+2212 MINUS SIGN rather than the ASCII hyphen. A hyphen is drawn above the
 * baseline, so a red `-62` next to a green `+62` reads as sitting higher even though the two spans
 * share a line box; the minus sign is drawn at the height a minus belongs, which is where the plus
 * already is.
 */
const MINUS = "\u2212";

export function lineCounts(
  added: number | null,
  removed: number | null,
): { added: string; removed: string } | null {
  if (added === null || removed === null) return null;
  return { added: `+${added}`, removed: `${MINUS}${removed}` };
}
