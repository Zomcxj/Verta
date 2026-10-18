import { describe, expect, it } from "vitest";

import {
  findImageReferences,
  nameInRow,
  type ScreenRow,
} from "@/modules/terminal/ghostty/terminalImages";

const COLUMNS = 40;

/** One character per column, the rest blank, as the model reports a row. */
function row(line: number, text: string): ScreenRow {
  const cells = [...text];
  while (cells.length < COLUMNS) cells.push(" ");
  return { line, cells };
}

describe("nameInRow", () => {
  it("reads a name containing spaces", () => {
    expect(nameInRow(" file 屏幕截图 2026-05-17 131455.png   ")).toEqual({
      name: "屏幕截图 2026-05-17 131455.png",
      column: 6,
    });
  });

  it("reads a plain name after the badge", () => {
    expect(nameInRow(" file 局部截取_20261018_153945.png")).toEqual({
      name: "局部截取_20261018_153945.png",
      column: 6,
    });
  });

  it("ignores a filename mentioned without the badge", () => {
    expect(nameInRow("这就是 截图 2026-05-17 131455.png 的说明")).toBeNull();
  });

  it("ignores a row with no filename at all", () => {
    expect(nameInRow("+ Thought · 5.3s")).toBeNull();
  });
});

describe("findImageReferences", () => {
  it("finds the picture above the filename", () => {
    const rows = [
      row(10, ""),
      row(11, "█▀▜     ▜▛██"),
      row(12, "██▄▙     ▟▄██"),
      row(13, ""),
      row(14, "[Image 1] 测试"),
      row(15, " file 屏幕截图 2026-05-17 131455.png"),
      row(16, ""),
    ];
    expect(findImageReferences(rows)).toEqual([
      {
        name: "屏幕截图 2026-05-17 131455.png",
        labelLine: 15,
        topLine: 11,
        bottomLine: 12,
        leftColumn: 0,
        rightColumn: 12,
      },
    ]);
  });

  it("keeps a mosaic that does not start at the first column", () => {
    const rows = [
      row(3, "      ████"),
      row(4, "      ████"),
      row(5, "      file shot_20260101.png"),
    ];
    expect(findImageReferences(rows)).toEqual([
      {
        name: "shot_20260101.png",
        labelLine: 5,
        topLine: 3,
        bottomLine: 4,
        leftColumn: 6,
        rightColumn: 9,
      },
    ]);
  });

  it("reports each picture of a message separately", () => {
    const rows = [
      row(1, "███"),
      row(2, " file a_20260101_000000.png"),
      row(3, " ███"),
      row(4, "███"),
      row(5, "[Image 2]"),
      row(6, " file b_20260101_000001.png"),
    ];
    expect(findImageReferences(rows)).toEqual([
      {
        name: "a_20260101_000000.png",
        labelLine: 2,
        topLine: 1,
        bottomLine: 1,
        leftColumn: 0,
        rightColumn: 2,
      },
      {
        name: "b_20260101_000001.png",
        labelLine: 6,
        topLine: 3,
        bottomLine: 4,
        leftColumn: 0,
        rightColumn: 3,
      },
    ]);
  });

  it("ignores chrome that shares the screen with the picture", () => {
    // The accent bar down the right edge is drawn with the same block
    // characters, so the picture has to be picked out by its own extent.
    const accent = (line: number) => row(line, " ".repeat(30) + "█");
    const picture = (line: number) => row(line, "█████     █████");
    const rows = [
      accent(1),
      picture(2),
      picture(3),
      picture(4),
      accent(5),
      row(6, " file shot_20260101.png"),
      accent(7),
    ];
    expect(findImageReferences(rows)).toEqual([
      {
        name: "shot_20260101.png",
        labelLine: 6,
        topLine: 2,
        bottomLine: 4,
        leftColumn: 0,
        rightColumn: 14,
      },
    ]);
  });

  it("draws nothing when the message reserved no space", () => {
    const rows = [
      row(1, "没有图片区域的文本"),
      row(2, "[Image 1] 测试"),
      row(3, " file 屏幕截图 2026-05-17 131455.png"),
    ];
    expect(findImageReferences(rows)).toEqual([]);
  });

  it("does not reach far above to an unrelated mosaic", () => {
    const rows = [
      row(1, "███"),
      ...Array.from({ length: 9 }, (_, index) => row(2 + index, "无关的旧内容")),
      row(12, "[Image 1] 测试"),
      row(13, " file 屏幕截图 2026-05-17 131455.png"),
    ];
    expect(findImageReferences(rows)).toEqual([]);
  });
});