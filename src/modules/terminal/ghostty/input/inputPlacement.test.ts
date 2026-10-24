import { describe, expect, it } from "vitest";
import { inputPlacement } from "./inputPlacement";

const CELL = { width: 7, height: 16 };

describe("inputPlacement", () => {
  it("puts the input on the cursor's cell", () => {
    expect(inputPlacement({ x: 12, y: 4 }, CELL, 120, 50)).toEqual({
      left: 84,
      top: 64,
      width: 7,
      height: 16,
    });
  });

  it("follows the cursor rather than the corner it used to sit in", () => {
    const first = inputPlacement({ x: 0, y: 0 }, CELL, 120, 50);
    const moved = inputPlacement({ x: 40, y: 20 }, CELL, 120, 50);
    expect(first).toEqual({ left: 0, top: 0, width: 7, height: 16 });
    expect(moved.left).toBe(280);
    expect(moved.top).toBe(320);
  });

  it("keeps the box inside the grid for a cursor that is off it", () => {
    expect(inputPlacement({ x: -3, y: -1 }, CELL, 120, 50)).toEqual({
      left: 0,
      top: 0,
      width: 7,
      height: 16,
    });
    expect(inputPlacement({ x: 200, y: 90 }, CELL, 120, 50)).toEqual({
      left: 119 * 7,
      top: 49 * 16,
      width: 7,
      height: 16,
    });
  });

  it("takes a fraction of a cell and nonsense for a cell without leaving a zero-sized box", () => {
    expect(inputPlacement({ x: 3.4, y: 2.6 }, CELL, 120, 50)).toEqual({
      left: 21,
      top: 48,
      width: 7,
      height: 16,
    });
    expect(inputPlacement({ x: Number.NaN, y: Number.NaN }, CELL, 120, 50)).toEqual({
      left: 0,
      top: 0,
      width: 7,
      height: 16,
    });
    const flat = inputPlacement({ x: 1, y: 1 }, { width: 0, height: 0 }, 120, 50);
    expect(flat.width).toBe(1);
    expect(flat.height).toBe(1);
  });

  it("copes with a grid that has no cells yet", () => {
    expect(inputPlacement({ x: 5, y: 5 }, CELL, 0, 0)).toEqual({
      left: 0,
      top: 0,
      width: 7,
      height: 16,
    });
  });
});