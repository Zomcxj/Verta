import { describe, expect, it } from "vitest";

import { AXIS_FILL, axisMax, axisTicks, significantCeiling } from "./axis";

/**
 * The chart's y axis, which is the one number a reader reads off a bar without being told.
 *
 * The rule under test is the user's: the tallest bar has to reach at least 90% of the axis. A scale
 * with headroom makes every bar shorter than it looks and every difference between two days smaller,
 * which is the failure that is invisible in a screenshot and obvious on a screen.
 */
describe("the trend chart's axis", () => {
  it("puts the tallest bar at the top of the axis, not at half of it", () => {
    // 130 over an axis of 250 draws the tallest day at 52%: the range looks half as tall as it is.
    expect(axisMax(130)).toBe(130);
    expect(axisMax(129)).toBe(130);
  });

  it("keeps the tallest bar at or above 90% of the axis for any value", () => {
    // Swept, because the bound is the whole point and an off-by-one in the rounding only shows up at
    // particular values. The steps are deliberately not integers: an integer multiple of a decade is
    // already two significant digits, and testing only those would test only the values that round
    // to themselves.
    let worst = 1;
    for (let exponent = -3; exponent <= 12; exponent += 1) {
      const decade = 10 ** exponent;
      for (let step = 100; step < 1000; step += 1) {
        const value = (decade * step) / 100;
        const fill = value / axisMax(value);
        if (fill < worst) worst = fill;
        expect(fill).toBeGreaterThanOrEqual(AXIS_FILL);
      }
    }
    // The bound is not slack: the worst case is a value a hair above a grid point, at about 91%.
    expect(worst).toBeLessThan(0.95);
    expect(worst).toBeGreaterThan(0.9);
  });

  it("rounds up rather than down, so no bar is clipped", () => {
    for (const value of [1, 7, 13, 101, 1234, 98765, 4_321_000]) {
      expect(axisMax(value)).toBeGreaterThanOrEqual(value);
    }
  });

  it("keeps two significant digits, which is what makes the bound reachable", () => {
    expect(significantCeiling(1234)).toBe(1300);
    expect(significantCeiling(1235)).toBe(1300);
    expect(significantCeiling(1300)).toBe(1300);
    expect(significantCeiling(0.001234)).toBe(0.0013);
  });

  it("does not push a value already on the grid to the next one", () => {
    // 13 * 0.1 is 1.3000000000000003 in binary floating point; rounding that up again gives 1.4.
    expect(significantCeiling(1.3)).toBe(1.3);
    expect(significantCeiling(0.3)).toBe(0.3);
  });

  it("has a scale to draw even when nothing was spent", () => {
    // A division by zero is not a chart, and an axis of zero has no ticks to label.
    expect(axisMax(0)).toBe(1);
    expect(axisMax(-5)).toBe(1);
    expect(axisMax(Number.NaN)).toBe(1);
    expect(axisTicks(1)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it("labels the ticks from zero to the top in equal steps", () => {
    const ticks = axisTicks(130);
    expect(ticks).toEqual([0, 32.5, 65, 97.5, 130]);
    // The top tick is the axis, so the label and the tallest bar agree.
    expect(ticks[ticks.length - 1]).toBe(axisMax(130));
  });
});
