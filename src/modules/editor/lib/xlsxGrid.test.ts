import { describe, expect, it } from "vitest";
import type { XlsxMerge } from "@/lib/native";
import {
  cellJustify,
  columnLabel,
  columnOffsets,
  columnWidths,
  draws,
  mergeCells,
  total,
  windowOf,
} from "./xlsxGrid";

describe("cellJustify", () => {
  it("lets the sheet's own alignment win", () => {
    expect(cellJustify("text", "right")).toBe("right");
    expect(cellJustify("number", "left")).toBe("left");
    expect(cellJustify("text", "center")).toBe("center");
  });

  it("puts a number at the right and a boolean in the middle", () => {
    expect(cellJustify("number", null)).toBe("right");
    expect(cellJustify("boolean", null)).toBe("center");
    expect(cellJustify("error", null)).toBe("center");
    expect(cellJustify("text", null)).toBe("left");
  });
});

describe("columnLabel", () => {
  it("names the first columns the way a spreadsheet does", () => {
    expect(columnLabel(0)).toBe("A");
    expect(columnLabel(1)).toBe("B");
    expect(columnLabel(25)).toBe("Z");
  });

  it("carries into two letters after Z", () => {
    // Bijective base 26: there is no zero digit, so 26 is AA and not BA.
    expect(columnLabel(26)).toBe("AA");
    expect(columnLabel(27)).toBe("AB");
    expect(columnLabel(51)).toBe("AZ");
    expect(columnLabel(52)).toBe("BA");
    expect(columnLabel(701)).toBe("ZZ");
    expect(columnLabel(702)).toBe("AAA");
  });
});

describe("columnWidths", () => {
  it("fills the columns the file says nothing about with the pane's own width", () => {
    expect(columnWidths(4, [{ index: 1, size: 200 }], 96)).toEqual([96, 200, 96, 96]);
  });

  it("keeps a hidden column at zero", () => {
    expect(columnWidths(2, [{ index: 0, size: 0 }], 96)).toEqual([0, 96]);
  });

  it("ignores a size for a column the sheet does not have", () => {
    expect(columnWidths(1, [{ index: 9, size: 200 }], 96)).toEqual([96]);
  });

  it("is empty for a sheet with no columns", () => {
    expect(columnWidths(0, [], 96)).toEqual([]);
  });
});

describe("columnOffsets", () => {
  it("starts each column where the one before it ended", () => {
    expect(columnOffsets([96, 200, 96])).toEqual([0, 96, 296]);
    expect(total([96, 200, 96])).toBe(392);
  });
});

describe("mergeCells", () => {
  it("marks every cell of a region, its own corner included", () => {
    const merge: XlsxMerge = { row: 1, column: 0, rowSpan: 2, columnSpan: 2 };
    const cells = mergeCells([merge]);
    expect(cells.get("1:0")).toBe(merge);
    expect(cells.get("1:1")).toBe(merge);
    expect(cells.get("2:0")).toBe(merge);
    expect(cells.get("2:1")).toBe(merge);
    expect(cells.get("3:0")).toBeUndefined();
  });

  it("only the corner of a region draws it", () => {
    const merge: XlsxMerge = { row: 0, column: 1, rowSpan: 1, columnSpan: 3 };
    expect(draws(merge, 0, 1)).toBe(true);
    expect(draws(merge, 0, 2)).toBe(false);
    // A cell with no region of its own draws itself.
    expect(draws(undefined, 5, 5)).toBe(true);
  });

  it("leaves a region too large to walk alone", () => {
    // A whole-column merge is written as a million rows; marking each one is not worth the budget.
    const whole: XlsxMerge = { row: 0, column: 0, rowSpan: 1_048_576, columnSpan: 1 };
    expect(mergeCells([whole]).size).toBe(0);
  });
});

describe("windowOf", () => {
  const widths = [100, 100, 100, 100, 100, 100];
  const offsets = columnOffsets(widths);

  it("draws the columns the viewport shows, with none to spare at the start", () => {
    const window = windowOf(offsets, widths, 0, 250, 0);
    expect(window).toEqual({ start: 0, count: 3 });
  });

  it("starts at the first column the viewport reaches once it has scrolled", () => {
    const window = windowOf(offsets, widths, 250, 200, 0);
    // Scrolled past A and B; C is the first column still partly in view.
    expect(window).toEqual({ start: 2, count: 3 });
  });

  it("adds the overscan either side", () => {
    const window = windowOf(offsets, widths, 200, 100, 1);
    expect(window).toEqual({ start: 1, count: 3 });
  });

  it("does not run past the last column", () => {
    const window = windowOf(offsets, widths, 500, 500, 4);
    // The viewport holds only the last column, and the overscan reaches back to the start of the
    // sheet without running off either end.
    expect(window).toEqual({ start: 1, count: 5 });
  });

  it("is empty for a sheet with no columns", () => {
    expect(windowOf([], [], 0, 500, 2)).toEqual({ start: 0, count: 0 });
  });
});
