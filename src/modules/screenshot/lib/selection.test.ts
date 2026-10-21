import { describe, expect, it } from "vitest";
import { dragBox, isUsableSelection, selectionRect } from "./selection";

const SHOT = { width: 2560, height: 1440 };

describe("selectionRect", () => {
  it("缩放 100% 时 CSS 像素就是物理像素", () => {
    expect(selectionRect({ x: 10, y: 20 }, { x: 110, y: 70 }, 1, SHOT)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it("往回拖也给同一块", () => {
    expect(selectionRect({ x: 110, y: 70 }, { x: 10, y: 20 }, 1, SHOT)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it("缩放 125% 时乘回物理像素", () => {
    expect(selectionRect({ x: 0, y: 0 }, { x: 100, y: 80 }, 1.25, SHOT)).toEqual({
      x: 0,
      y: 0,
      width: 125,
      height: 100,
    });
    expect(selectionRect({ x: 100, y: 80 }, { x: 0, y: 0 }, 1.25, SHOT)).toEqual({
      x: 0,
      y: 0,
      width: 125,
      height: 100,
    });
  });

  it("取整宁可多含一列，不少给一列", () => {
    // 10.6 → 110.2：向下取到 10、向上取到 111，宽 101。
    expect(selectionRect({ x: 10.6, y: 20.9 }, { x: 110.2, y: 70.1 }, 1, SHOT)).toEqual({
      x: 10,
      y: 20,
      width: 101,
      height: 51,
    });
  });

  it("拖出画面就贴着边收", () => {
    expect(selectionRect({ x: -40, y: -30 }, { x: 100, y: 100 }, 1, SHOT)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    expect(selectionRect({ x: 2500, y: 1400 }, { x: 9999, y: 9999 }, 1, SHOT)).toEqual({
      x: 2500,
      y: 1400,
      width: 60,
      height: 40,
    });
  });

  it("缩放给不出好值时按 100% 算，不把选区乘成 NaN", () => {
    for (const dpr of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(selectionRect({ x: 10, y: 10 }, { x: 60, y: 60 }, dpr, SHOT)).toEqual({
        x: 10,
        y: 10,
        width: 50,
        height: 50,
      });
    }
  });
});

describe("isUsableSelection", () => {
  it("太小的不算选中", () => {
    expect(isUsableSelection({ x: 0, y: 0, width: 8, height: 8 })).toBe(true);
    expect(isUsableSelection({ x: 0, y: 0, width: 7, height: 200 })).toBe(false);
    expect(isUsableSelection({ x: 0, y: 0, width: 200, height: 7 })).toBe(false);
    expect(isUsableSelection({ x: 0, y: 0, width: 0, height: 0 })).toBe(false);
  });
});

describe("dragBox", () => {
  it("往前往后拖都是同一个框", () => {
    const forward = dragBox({ x: 10, y: 20 }, { x: 110, y: 70 });
    expect(forward).toEqual({ left: 10, top: 20, width: 100, height: 50 });
    expect(dragBox({ x: 110, y: 70 }, { x: 10, y: 20 })).toEqual(forward);
  });
});