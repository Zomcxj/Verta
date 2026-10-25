/**
 * How many of a path's middle segments fit in the room the breadcrumb has.
 *
 * The status bar used to collapse every middle segment whenever the window was narrower than a
 * breakpoint (768px), which hid a path that had room to be shown - a 740px window left a 212px row
 * holding one folder and the current name - and left a long path scroll-clipped at every width above
 * the breakpoint. What fits is measured instead, and the trailing segments are the ones kept, since
 * the folder the user is in lives at that end.
 *
 * Each part is the widths of the boxes it renders, in order, so the caller hands over what the DOM
 * measured and this stays a pure function that knows nothing about the markup: the leading part is
 * the first segment with its separator, the more part is the "more paths" button with the separator
 * after it, each middle is one segment with the separator after it, and the trailing part is the
 * current folder or file.
 */
export function fitBreadcrumb(input: {
  /** Room the list has for its content, in the same unit as the widths. */
  available: number;
  /** Space the list puts between two boxes. */
  gap: number;
  leading: readonly number[];
  more: readonly number[];
  middles: readonly (readonly number[])[];
  trailing: readonly number[];
}): number {
  const { available, gap, leading, more, middles, trailing } = input;
  // A list that has not been laid out yet reports no room; showing everything is what it does then,
  // and the measurement that follows corrects it. Collapsing everything instead would flash an empty
  // trail on every render before the first pass.
  if (available <= 0) return middles.length;

  const width = (kept: number): number => {
    const boxes = [
      ...leading,
      ...(kept < middles.length ? more : []),
      ...middles.slice(middles.length - kept).flat(),
      ...trailing,
    ];
    const spaces = Math.max(0, boxes.length - 1) * gap;
    return boxes.reduce((sum, value) => sum + value, 0) + spaces;
  };

  for (let kept = middles.length; kept >= 0; kept -= 1) {
    if (width(kept) <= available) return kept;
  }
  return 0;
}
