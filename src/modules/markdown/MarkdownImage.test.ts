import { describe, expect, it } from "vitest";

import { previewImageStyle } from "./MarkdownImage";

const base = { table: null, requested: undefined, requestedWidth: undefined };

describe("previewImageStyle", () => {
  it("表格里给什么就用什么（不做 maxWidth 的限制）", () => {
    expect(
      previewImageStyle({ ...base, table: { height: 120, width: 300 }, loaded: true }),
    ).toEqual({ height: "120px", width: "300px", maxWidth: "none" });
  });

  it("作者写了高度就照写，宽度写了才跟", () => {
    expect(previewImageStyle({ ...base, requested: 400, loaded: true })).toEqual({
      height: "400px",
      maxWidth: "100%",
    });
    expect(
      previewImageStyle({ ...base, requested: 400, requestedWidth: 200, loaded: true }),
    ).toEqual({ height: "400px", width: "200px", maxWidth: "100%" });
  });

  it("没写尺寸时先按 260px 占位（大截图加载完不会顶一屏）", () => {
    expect(previewImageStyle({ ...base, loaded: false })).toEqual({
      height: "260px",
      maxWidth: "100%",
    });
  });

  it("加载完回到图片自己的尺寸，260px 只当封顶 —— 徽章不许被撑成大横幅", () => {
    const style = previewImageStyle({ ...base, loaded: true });
    expect(style).toEqual({ maxHeight: "260px", maxWidth: "100%" });
    expect(style.height).toBeUndefined();
  });
});