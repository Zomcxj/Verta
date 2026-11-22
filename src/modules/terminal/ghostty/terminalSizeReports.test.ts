import { describe, expect, it } from "vitest";

import {
  DeferredSizeReports,
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

describe("DeferredSizeReports", () => {
  it("answers a query that arrived before the cell size was known", () => {
    // The measured failure: the program asks once, at startup, and the surface has not measured
    // itself yet. Dropping that query means the program never asks again, so it draws its picture on
    // a coarse fixed grid instead of from the terminal's real pixels.
    const replies: string[] = [];
    let known: TerminalPixelGeometry | null = null;
    const reports = new DeferredSizeReports(
      (reply) => replies.push(reply),
      () => known,
    );

    reports.observe("booting[14t");
    expect(replies).toEqual([]);

    known = geometry;
    reports.flush();
    expect(replies).toEqual(["[4;510;850t"]);
  });

  it("answers at once once the size is known", () => {
    const replies: string[] = [];
    const reports = new DeferredSizeReports(
      (reply) => replies.push(reply),
      () => geometry,
    );
    reports.observe("[16t");
    expect(replies).toEqual(["[6;17;9t"]);
  });

  it("does not answer twice for one query", () => {
    const replies: string[] = [];
    const reports = new DeferredSizeReports(
      (reply) => replies.push(reply),
      () => geometry,
    );
    reports.observe("[14t");
    reports.flush();
    reports.flush();
    expect(replies).toHaveLength(1);
  });

  it("holds a bounded amount while the size stays unknown", () => {
    const replies: string[] = [];
    let known: TerminalPixelGeometry | null = null;
    const reports = new DeferredSizeReports(
      (reply) => replies.push(reply),
      () => known,
    );
    reports.observe("x".repeat(20_000));
    known = geometry;
    reports.observe("[14t");
    expect(replies).toEqual(["[4;510;850t"]);
  });

  it("says nothing while the size is still unknown", () => {
    const replies: string[] = [];
    const reports = new DeferredSizeReports(
      (reply) => replies.push(reply),
      () => null,
    );
    reports.observe("[14t");
    reports.flush();
    expect(replies).toEqual([]);
  });
});
