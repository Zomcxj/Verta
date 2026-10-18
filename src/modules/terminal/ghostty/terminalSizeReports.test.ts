import { describe, expect, it } from "vitest";

import {
  TerminalSizeReports,
  type TerminalPixelGeometry,
} from "@/modules/terminal/ghostty/terminalSizeReports";

const geometry: TerminalPixelGeometry = {
  cols: 100,
  rows: 30,
  cellWidth: 8.5,
  cellHeight: 17,
  originX: 2,
  originY: 3,
};

function observeAll(...chunks: string[]): (string | null)[] {
  const reports = new TerminalSizeReports();
  return chunks.map((chunk) => reports.observe(chunk, geometry));
}

describe("TerminalSizeReports", () => {
  it("reports the text area in pixels for CSI 14 t", () => {
    expect(observeAll("\u001b[14t")).toEqual(["\u001b[4;510;850t"]);
  });

  it("rounds fractional pixel sizes to integers", () => {
    const reports = new TerminalSizeReports();
    const reply = reports.observe("\u001b[16t", geometry);
    expect(reply).toBe("\u001b[6;17;9t");
  });

  it("reports cells instead of pixels when the request asks for cells", () => {
    expect(observeAll("\u001b[14;2t")).toEqual(["\u001b[4;30;100t"]);
  });

  it("reports the cell size, text area position, and both cell counts", () => {
    expect(
      observeAll("\u001b[16t\u001b[13t\u001b[18t\u001b[19t\u001b[15t"),
    ).toEqual(["\u001b[6;17;9t\u001b[3;3;2t\u001b[8;30;100t\u001b[9;30;100t\u001b[5;510;850t"]);
  });

  it("answers a query split across two reads", () => {
    expect(observeAll("\u001b[1", "4t")).toEqual([null, "\u001b[4;510;850t"]);
  });

  it("answers a query that arrives after unrelated drawing", () => {
    expect(observeAll("\u001b[?25l\u001b[H\u001b[2J\u001b[14t")).toEqual([
      "\u001b[4;510;850t",
    ]);
  });

  it("does not answer the same query twice", () => {
    const reports = new TerminalSizeReports();
    expect(reports.observe("\u001b[14t", geometry)).toBe("\u001b[4;510;850t");
    expect(reports.observe("", geometry)).toBeNull();
    expect(reports.observe("t", geometry)).toBeNull();
  });

  it("ignores escape sequences that only look similar", () => {
    expect(
      observeAll("\u001b[14m\u001b[?1049h\u001b[38;2;1;2;3m\u001b[15;20H"),
    ).toEqual([null]);
  });

  it("returns nothing for ordinary output", () => {
    expect(observeAll("hello world\n")).toEqual([null]);
  });

  it("stops answering after reset", () => {
    const reports = new TerminalSizeReports();
    reports.observe("\u001b[1", geometry);
    reports.reset();
    expect(reports.observe("4t", geometry)).toBeNull();
  });
});