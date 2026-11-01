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

/**
 * The one letter a changed-file row shows after its counts: `M`, `D`, `A`, `U`, or `R`.
 *
 * The row already colours a bar by this code, but a colour alone does not say what happened to the
 * file - amber could be an edit or a rename. The letter says it, in the same slot every row, so a
 * column of them reads at a glance. It sits after the counts (`+12 −3 M`) because the counts are
 * what the row is mostly about and the letter is the annotation.
 */
export function statusLetter(code: string): string {
  switch (code) {
    case "A":
      return "A";
    case "M":
      return "M";
    case "D":
      return "D";
    case "R":
      return "R";
    case "U":
      return "U";
    default:
      // An untracked file is reported as `?` by git and normalised to `U` before it reaches here,
      // so this only catches a code this build does not know: show nothing rather than a wrong
      // letter.
      return "";
  }
}

/** What the letter is called, for the row's tooltip and its accessible label. */
export function statusLetterLabel(code: string): string {
  switch (code) {
    case "A":
      return "Added";
    case "M":
      return "Modified";
    case "D":
      return "Deleted";
    case "R":
      return "Renamed";
    case "U":
      return "Untracked";
    default:
      return "";
  }
}
