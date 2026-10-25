import { describe, expect, it } from "vitest";
import { fitBreadcrumb } from "./breadcrumbFit";

/** A trail of one-segment-wide boxes: the leading folder, `middles` folders, the current one. */
function trail(middles: number, options: { gap?: number; more?: number } = {}) {
  const gap = options.gap ?? 6;
  return {
    gap,
    leading: [60, 12],
    more: [24, 12],
    middles: Array.from({ length: middles }, () => [40, 12] as const),
    trailing: [120],
  };
}

describe("fitBreadcrumb", () => {
  it("keeps every middle segment when the whole trail fits", () => {
    // 72 + 3 * 52 + 120 + 5 * 6 = 402, and the room is wider than that.
    expect(
      fitBreadcrumb({ ...trail(3), available: 500 }),
    ).toBe(3);
  });

  it("drops the middle segments from the leading end", () => {
    // Each kept middle costs 52 plus a gap; without one, the "more" button costs 36.
    // Room for the leading part, the button, the trails and two middles: 72 + 36 + 2 * 52 + 120
    // plus 5 gaps = 362.
    expect(fitBreadcrumb({ ...trail(5), available: 380 })).toBe(2);
  });

  it("keeps none when only the ends and the button fit", () => {
    // 72 + 36 + 120 plus 4 gaps = 252.
    expect(fitBreadcrumb({ ...trail(5), available: 260 })).toBe(0);
  });

  it("keeps none when not even the ends and the button fit", () => {
    expect(fitBreadcrumb({ ...trail(5), available: 100 })).toBe(0);
  });

  it("shows everything when the list has no measurable room yet", () => {
    expect(fitBreadcrumb({ ...trail(4), available: 0 })).toBe(4);
  });

  it("counts the gap between every pair of boxes", () => {
    // The same trail, with the gap wide enough that one fewer middle fits.
    expect(fitBreadcrumb({ ...trail(5, { gap: 20 }), available: 380 })).toBe(0);
    expect(fitBreadcrumb({ ...trail(5, { gap: 20 }), available: 420 })).toBe(1);
  });

  it("has nothing to keep when the path has no middle segments", () => {
    expect(fitBreadcrumb({ ...trail(0), available: 500 })).toBe(0);
  });
});
