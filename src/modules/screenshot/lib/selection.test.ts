import { describe, expect, it } from "vitest";
import {
  dragBox,
  handleCursor,
  isUsableSelection,
  MIN_SIDE,
  moveRect,
  resizeRect,
  selectionRect,
  toPhysical,
} from "./selection";

const SHOT = { width: 2560, height: 1440 };

describe("selectionRect", () => {
  it("缩放 100% 时 CSS 像素就是物理像素", () => {
    expect(selectionRect({ x: 10, y: 20 }, { x: 110, y: 70 }, 1, SHOT)).toEqual(
      {
        x: 10,
        y: 20,
        width: 100,
        height: 50,
      },
    );
  });

  it("往回拖也给同一块", () => {
    expect(selectionRect({ x: 110, y: 70 }, { x: 10, y: 20 }, 1, SHOT)).toEqual(
      {
        x: 10,
        y: 20,
        width: 100,
        height: 50,
      },
    );
  });

  it("缩放 125% 时乘回物理像素", () => {
    expect(
      selectionRect({ x: 0, y: 0 }, { x: 100, y: 80 }, 1.25, SHOT),
    ).toEqual({
      x: 0,
      y: 0,
      width: 125,
      height: 100,
    });
    expect(
      selectionRect({ x: 100, y: 80 }, { x: 0, y: 0 }, 1.25, SHOT),
    ).toEqual({
      x: 0,
      y: 0,
      width: 125,
      height: 100,
    });
  });

  it("取整宁可多含一列，不少给一列", () => {
    // 10.6 → 110.2：向下取到 10、向上取到 111，宽 101。
    expect(
      selectionRect({ x: 10.6, y: 20.9 }, { x: 110.2, y: 70.1 }, 1, SHOT),
    ).toEqual({
      x: 10,
      y: 20,
      width: 101,
      height: 51,
    });
  });

  it("拖出画面就贴着边收", () => {
    expect(
      selectionRect({ x: -40, y: -30 }, { x: 100, y: 100 }, 1, SHOT),
    ).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    expect(
      selectionRect({ x: 2500, y: 1400 }, { x: 9999, y: 9999 }, 1, SHOT),
    ).toEqual({
      x: 2500,
      y: 1400,
      width: 60,
      height: 40,
    });
  });

  it("缩放给不出好值时按 100% 算，不把选区乘成 NaN", () => {
    for (const dpr of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        selectionRect({ x: 10, y: 10 }, { x: 60, y: 60 }, dpr, SHOT),
      ).toEqual({
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
    expect(isUsableSelection({ x: 0, y: 0, width: 7, height: 200 })).toBe(
      false,
    );
    expect(isUsableSelection({ x: 0, y: 0, width: 200, height: 7 })).toBe(
      false,
    );
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

const SHOT_CSS = { width: 1280, height: 720 };

describe("moveRect", () => {
  it("整块挪，尺寸不变", () => {
    const moved = moveRect(
      { x: 100, y: 100, width: 200, height: 80 },
      30,
      -20,
      SHOT_CSS,
    );
    expect(moved).toEqual({ x: 130, y: 80, width: 200, height: 80 });
  });

  it("四条边都不许出画面", () => {
    const box = { x: 100, y: 100, width: 200, height: 80 };
    expect(moveRect(box, 9999, 0, SHOT_CSS).x).toBe(SHOT_CSS.width - 200);
    expect(moveRect(box, -9999, 0, SHOT_CSS).x).toBe(0);
    expect(moveRect(box, 0, 9999, SHOT_CSS).y).toBe(SHOT_CSS.height - 80);
    expect(moveRect(box, 0, -9999, SHOT_CSS).y).toBe(0);
  });
});

describe("resizeRect", () => {
  const base = { x: 100, y: 100, width: 200, height: 100 };

  it("拉右下角：左上角不动", () => {
    expect(resizeRect(base, "se", 50, 30, SHOT_CSS)).toEqual({
      x: 100,
      y: 100,
      width: 250,
      height: 130,
    });
  });

  it("拉左上角：右下角不动", () => {
    expect(resizeRect(base, "nw", 20, 10, SHOT_CSS)).toEqual({
      x: 120,
      y: 110,
      width: 180,
      height: 90,
    });
  });

  it("拉边只动那一条边", () => {
    expect(resizeRect(base, "e", 40, 0, SHOT_CSS)).toEqual({
      ...base,
      width: 240,
    });
    expect(resizeRect(base, "n", 0, 25, SHOT_CSS)).toEqual({
      x: 100,
      y: 125,
      width: 200,
      height: 75,
    });
  });

  it("撞到画面边就停在边上", () => {
    const grown = resizeRect(base, "se", 9999, 9999, SHOT_CSS);
    expect(grown.x + grown.width).toBe(SHOT_CSS.width);
    expect(grown.y + grown.height).toBe(SHOT_CSS.height);
    const shrunk = resizeRect(base, "nw", -9999, -9999, SHOT_CSS);
    expect(shrunk.x).toBe(0);
    expect(shrunk.y).toBe(0);
  });

  it("两边都不许小于最小边长", () => {
    const tiny = resizeRect(base, "se", -9999, -9999, SHOT_CSS);
    expect(tiny.width).toBe(MIN_SIDE);
    expect(tiny.height).toBe(MIN_SIDE);
    // 往回拉过头也不会翻面（宽高始终为正，最小的那一边贴住把手）。
    expect(tiny.x).toBe(100);
    expect(tiny.y).toBe(100);
  });
});

describe("toPhysical", () => {
  it("缩放 100% 时原样取整（宁可多含一列）", () => {
    expect(
      toPhysical({ x: 10.6, y: 20.9, width: 99.6, height: 49.2 }, 1, SHOT),
    ).toEqual({
      x: 10,
      y: 20,
      width: 101,
      height: 51,
    });
  });

  it("缩放 125% 时乘回物理像素", () => {
    expect(
      toPhysical({ x: 0, y: 0, width: 100, height: 80 }, 1.25, SHOT),
    ).toEqual({
      x: 0,
      y: 0,
      width: 125,
      height: 100,
    });
  });

  it("不许超出画面", () => {
    expect(
      toPhysical({ x: -50, y: -50, width: 200, height: 200 }, 1, SHOT),
    ).toEqual({
      x: 0,
      y: 0,
      width: 150,
      height: 150,
    });
    expect(
      toPhysical({ x: 2500, y: 1400, width: 500, height: 500 }, 1, SHOT),
    ).toEqual({
      x: 2500,
      y: 1400,
      width: 60,
      height: 40,
    });
  });
});

describe("isUsableSelection 按物理像素算", () => {
  it("CSS 上看着小、物理上够大也算数", () => {
    // 125% 缩放下，CSS 8 像素其实有 10 个物理像素。
    expect(isUsableSelection({ x: 0, y: 0, width: 8, height: 8 }, 1.25)).toBe(
      true,
    );
    expect(isUsableSelection({ x: 0, y: 0, width: 4, height: 40 }, 1.25)).toBe(
      false,
    );
    expect(isUsableSelection({ x: 0, y: 0, width: 8, height: 8 }, 1)).toBe(
      true,
    );
    expect(isUsableSelection({ x: 0, y: 0, width: 7, height: 8 }, 1)).toBe(
      false,
    );
  });
});

describe("handleCursor", () => {
  it("四角与四边各给对应的光标", () => {
    expect(handleCursor("n")).toBe("ns-resize");
    expect(handleCursor("w")).toBe("ew-resize");
    expect(handleCursor("ne")).toBe("nesw-resize");
    expect(handleCursor("nw")).toBe("nwse-resize");
  });
});
