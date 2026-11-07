import { describe, expect, it } from "vitest";
import {
  clampWidth,
  draggedWidth,
  effectiveWidths,
  grabbedColumn,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  widthOf,
} from "./columnResize";

describe("clampWidth", () => {
  it("keeps a width inside what the pane allows", () => {
    expect(clampWidth(120)).toBe(120);
    expect(clampWidth(4)).toBe(MIN_COLUMN_WIDTH);
    expect(clampWidth(99_999)).toBe(MAX_COLUMN_WIDTH);
  });

  it("rounds to whole pixels, so a drag does not leave a fraction behind", () => {
    expect(clampWidth(120.6)).toBe(121);
  });
});

describe("grabbedColumn", () => {
  const offsets = [0, 96, 296, 396];
  const widths = [96, 200, 100, 100];

  it("grabs the column whose trailing edge was pressed", () => {
    // The first column ends at 96, the second at 296.
    expect(grabbedColumn(offsets, widths, 96)).toBe(0);
    expect(grabbedColumn(offsets, widths, 296)).toBe(1);
  });

  it("grabs nothing when the press is inside a column", () => {
    expect(grabbedColumn(offsets, widths, 40)).toBeNull();
    expect(grabbedColumn(offsets, widths, 200)).toBeNull();
  });

  it("allows for the grip on either side of the edge", () => {
    expect(grabbedColumn(offsets, widths, 93)).toBe(0);
    expect(grabbedColumn(offsets, widths, 99)).toBe(0);
    // Beyond the grip, it is not a grab.
    expect(grabbedColumn(offsets, widths, 88)).toBeNull();
  });
});

describe("draggedWidth", () => {
  it("moves the trailing edge by how far the pointer moved", () => {
    // Starting at 96 wide, pressed at x=96 and moved to 140: 44 pixels wider.
    expect(draggedWidth(96, 96, 140)).toBe(140);
    expect(draggedWidth(96, 96, 60)).toBe(60);
  });

  it("does not let a drag make a column too narrow or too wide", () => {
    expect(draggedWidth(96, 96, 10)).toBe(MIN_COLUMN_WIDTH);
    expect(draggedWidth(96, 96, 5000)).toBe(MAX_COLUMN_WIDTH);
  });
});

describe("widthOf", () => {
  it("lets the dragged width win over the file's", () => {
    const dragged = new Map([[1, 240]]);
    expect(widthOf(0, [96, 200], dragged)).toBe(96);
    expect(widthOf(1, [96, 200], dragged)).toBe(240);
  });

  it("falls back to the minimum for a column with no width at all", () => {
    expect(widthOf(5, [], new Map())).toBe(MIN_COLUMN_WIDTH);
  });
});

describe("effectiveWidths", () => {
  it("lays the dragged widths over the file's for every column", () => {
    const dragged = new Map([[2, 400]]);
    expect(effectiveWidths(4, [96, 200, 100, 100], dragged)).toEqual([96, 200, 400, 100]);
  });

  it("is empty for a table with no columns", () => {
    expect(effectiveWidths(0, [], new Map())).toEqual([]);
  });
});
