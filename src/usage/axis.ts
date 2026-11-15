/**
 * The trend chart's y axis.
 *
 * The axis has one job the chart cannot do for itself: a reader compares bar heights, and a scale
 * with too much headroom makes every bar short and the differences between them small. A maximum of
 * 250 for a tallest day of 130 draws that day at 52% of the plot, which reads as "about half" for a
 * number that is in fact the whole story of the range. So the axis is the tallest bar's own value
 * rounded up, and the rounding is bounded: two significant digits at most, which is a ceiling within
 * 10% of the value (the worst case is a value a hair above `1.0` becoming `1.1`), so the tallest bar
 * always reaches at least 90% of the axis.
 *
 * Two significant digits rather than a "round" step of 1/2/5 is what makes that bound hold. A step
 * chosen so that five of them cover the tallest bar can land anywhere: 130 needs a step of 26 to 28
 * to stay inside the bound, and no round step sits in that window - 25 is too small, 30 draws the
 * day at 87%. Rounding the maximum itself has no such gap.
 *
 * The tick labels are derived from that maximum, so they are as round as it is: 0, 325K, 650K, 975K,
 * 1.3M. `compactTokens` prints them to one decimal, which is the precision a chart label can carry
 * anyway.
 */

/** The share of the axis the tallest bar must reach. */
export const AXIS_FILL = 0.9;

/**
 * `value` rounded up to `digits` significant digits.
 *
 * The epsilon keeps a value that is already on the grid from being pushed to the next one by
 * floating-point error: 13 * 0.1 is 1.3000000000000003, and rounding that up again would give 1.4.
 */
export function significantCeiling(value: number, digits = 2): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const exponent = Math.floor(Math.log10(value));
  const scale = 10 ** (exponent - digits + 1);
  return Number((Math.ceil(value / scale - 1e-9) * scale).toPrecision(12));
}

/**
 * The axis maximum for a tallest bar of `value`.
 *
 * A chart of nothing but zeros still needs a scale to draw, so the empty case is 1 rather than 0: a
 * division by zero is not a chart. Every other value is rounded up on its own scale - no floor of 1,
 * which would draw a tallest bar of 0.4 at 40% of an axis of 1.
 */
export function axisMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return significantCeiling(value, 2);
}

/** The values the y labels sit at, from zero to the top, `steps` intervals apart. */
export function axisTicks(max: number, steps = 4): number[] {
  const out: number[] = [];
  for (let index = 0; index <= steps; index += 1) {
    out.push(Number(((max * index) / steps).toPrecision(12)));
  }
  return out;
}
