import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { columnWidths, delimiterName } from "./CsvPreview";

const here = path.dirname(fileURLToPath(import.meta.url));
const pane = readFileSync(path.join(here, "EditorPane.tsx"), "utf8");
const csv = readFileSync(path.join(here, "CsvPreview.tsx"), "utf8");

describe("a csv column's width", () => {
  it("grows with the widest cell in it, up to a limit", () => {
    const widths = columnWidths(
      [
        ["id", "name"],
        ["1", "Ponytail"],
        ["2", "x".repeat(200)],
      ],
      2,
    );
    // The id column holds "id" and "1": the floor, not the text.
    expect(widths[0]).toBe(72);
    // The name column takes the longest cell, capped so one cell cannot push the rest off screen.
    expect(widths[1]).toBe(320);
  });

  it("has one width per column, even for a row that is short", () => {
    expect(columnWidths([["a", "b", "c"], ["1"]], 3)).toHaveLength(3);
    expect(columnWidths([], 4)).toEqual([72, 72, 72, 72]);
  });

  it("names the delimiter a reader can see", () => {
    expect(delimiterName("\t")).toBe("Tab");
    expect(delimiterName(";")).toBe(";");
    expect(delimiterName(",")).toBe(",");
  });
});

describe("the csv table", () => {
  it("is read by the Rust side, and says what it read", () => {
    expect(csv).toMatch(/invoke<CsvDocument>\("fs_read_csv"/);
    expect(csv).toMatch(/workspace: envForPath\(path\)/);
    expect(csv).toMatch(/data-csv-preview/);
    expect(csv).toMatch(/sticky top-0/);
  });

  it("draws only the rows that are on screen", () => {
    // A file of five thousand rows is a list to be scrolled, not five thousand elements.
    expect(csv).toMatch(/useVirtualizer\(\{/);
    expect(csv).toMatch(/getVirtualItems\(\)\.map/);
  });
});

describe("csv routing in the editor pane", () => {
  it("opens as a table, with the source one click away", () => {
    expect(pane).toMatch(/const isCsv = fileExt === "csv" \|\| fileExt === "tsv";/);
    expect(pane).toMatch(/const csvRendering = isCsv && csvRendered && !dirty;/);
    expect(pane).toMatch(/\) : csvRendering \? \(\s*<CsvPreview path=\{path\} \/>/);
    // The table shows the file on disk, so a buffer with unsaved edits shows the text instead.
    expect(pane).toMatch(/renderedDisabled=\{dirty\}/);
  });
});
