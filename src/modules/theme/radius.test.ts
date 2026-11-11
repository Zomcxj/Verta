import { describe, expect, it } from "vitest";
import {
  DEFAULT_RADIUS,
  isRadiusStop,
  RADIUS_STOPS,
  radiusOf,
  radiusStopIndex,
  resolveRadius,
} from "./radius";
import { resolveShape, listShapes } from "./shape";

describe("radius stops", () => {
  it("offers the seven stops that cover every radius a shape used to carry", () => {
    expect(RADIUS_STOPS).toEqual([
      "0",
      "0.25rem",
      "0.375rem",
      "0.5rem",
      "0.625rem",
      "0.875rem",
      "1rem",
    ]);
    // The value the stylesheet had before this axis existed, so a saved look does not change.
    expect(DEFAULT_RADIUS).toBe("0.625rem");
    expect(RADIUS_STOPS).toContain(DEFAULT_RADIUS);
    // 0.375rem and 0.5rem and 1rem were shapes' own radii (slab, emboss/glass, cloud).
    for (const px of [6, 8, 10, 16]) {
      expect(RADIUS_STOPS.some((stop) => Number.parseFloat(stop) * 16 === px)).toBe(
        true,
      );
    }
  });

  it("answers the default for anything it does not recognise", () => {
    // A settings file can be edited by hand, and a stop that no longer exists must not blank the
    // corners or leave the slider without a position.
    expect(radiusOf(undefined)).toBe(DEFAULT_RADIUS);
    expect(radiusOf(null)).toBe(DEFAULT_RADIUS);
    expect(radiusOf("")).toBe(DEFAULT_RADIUS);
    expect(radiusOf("1.5rem")).toBe(DEFAULT_RADIUS);
    expect(radiusOf(10)).toBe(DEFAULT_RADIUS);
    expect(radiusOf({})).toBe(DEFAULT_RADIUS);
    expect(isRadiusStop("0.5rem")).toBe(true);
    expect(isRadiusStop("0.5")).toBe(false);
  });

  it("writes nothing but the radius", () => {
    expect(resolveRadius("0.25rem")).toEqual({
      vars: { "--radius": "0.25rem" },
    });
    expect(resolveRadius("nonsense").vars["--radius"]).toBe(DEFAULT_RADIUS);
    expect(Object.keys(resolveRadius("1rem").vars)).toEqual(["--radius"]);
  });

  it("maps a stop to its position on the slider", () => {
    expect(radiusStopIndex("0")).toBe(0);
    expect(radiusStopIndex("0.625rem")).toBe(4);
    expect(radiusStopIndex("1rem")).toBe(6);
    expect(radiusStopIndex("bogus")).toBe(4);
  });

  it("leaves the radius to the shapes' other axes", () => {
    // The whole point of this axis: no shape writes a radius any more.
    for (const id of listShapes()) {
      expect(resolveShape(id).vars["--radius"]).toBeUndefined();
    }
  });
});
