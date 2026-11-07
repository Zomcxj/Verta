import { describe, expect, it } from "vitest";
import type { PptxRun, PptxSlide } from "@/lib/native";
import {
  fitScale,
  paperStyle,
  paragraphAlign,
  paragraphIndent,
  paragraphText,
  runSizePx,
  runStyle,
} from "./pptxLayout";

describe("fitScale", () => {
  it("scales a slide to the room it has", () => {
    // A 960px slide in a 480px pane is drawn at half size.
    expect(fitScale(960, 480, 1)).toBe(0.5);
  });

  it("multiplies by the zoom the user asked for", () => {
    expect(fitScale(960, 480, 2)).toBe(1);
    expect(fitScale(960, 480, 0.5)).toBe(0.25);
  });

  it("leaves the zoom alone when there is nothing to fit to yet", () => {
    // Before the pane has been measured, or for a slide the file gave no size to.
    expect(fitScale(0, 480, 1.5)).toBe(1.5);
    expect(fitScale(960, 0, 1.5)).toBe(1.5);
    expect(fitScale(960, -10, 1.5)).toBe(1.5);
  });
});

describe("paragraphIndent", () => {
  it("indents by outline level and not by a negative one", () => {
    expect(paragraphIndent(0)).toBe(0);
    expect(paragraphIndent(1)).toBe(48);
    expect(paragraphIndent(4)).toBe(192);
    expect(paragraphIndent(-1)).toBe(0);
  });
});

describe("paragraphAlign", () => {
  it("maps a deck's own words for alignment", () => {
    expect(paragraphAlign("center")).toBe("center");
    expect(paragraphAlign("right")).toBe("right");
    expect(paragraphAlign("justify")).toBe("justify");
    expect(paragraphAlign("left")).toBe("left");
    // A paragraph that says nothing starts at the left.
    expect(paragraphAlign(undefined)).toBe("left");
  });
});

describe("a run's size", () => {
  it("is the point size it declares, in pixels", () => {
    const run: PptxRun = { text: "x", bold: false, italic: false, underline: false, size: 24 };
    // 24pt at 96 dpi is 32px.
    expect(runSizePx(run, 18)).toBeCloseTo(32, 5);
  });

  it("falls back to the shape's own size when the run states none", () => {
    const run: PptxRun = { text: "x", bold: false, italic: false, underline: false };
    expect(runSizePx(run, 18)).toBeCloseTo(24, 5);
  });
});

describe("runStyle", () => {
  it("carries every weight the run declares", () => {
    const run: PptxRun = {
      text: "x",
      bold: true,
      italic: true,
      underline: true,
      size: 18,
      color: "#ff0000",
      font: "Calibri",
    };
    const style = runStyle(run, 18);
    expect(style.fontWeight).toBe(600);
    expect(style.fontStyle).toBe("italic");
    expect(style.textDecoration).toBe("underline");
    expect(style.fontSize).toBe("24px");
    expect(style.color).toBe("#ff0000");
    expect(style.fontFamily).toBe("Calibri");
  });

  it("says nothing the run does not", () => {
    const run: PptxRun = { text: "x", bold: false, italic: false, underline: false };
    const style = runStyle(run, 12);
    expect(style.fontWeight).toBeUndefined();
    expect(style.color).toBeUndefined();
    expect(style.fontFamily).toBeUndefined();
    expect(style.fontSize).toBe("16px");
  });
});

describe("paragraphText", () => {
  it("joins the runs, line breaks and all", () => {
    expect(
      paragraphText({
        level: 0,
        bullets: false,
        runs: [
          { text: "one", bold: false, italic: false, underline: false },
          { text: "\n", bold: false, italic: false, underline: false },
          { text: "two", bold: false, italic: false, underline: false },
        ],
      }),
    ).toBe("one\ntwo");
  });
});

describe("what a slide is drawn on", () => {
  const slide = (over: Partial<PptxSlide> = {}): PptxSlide => ({
    index: 0,
    shapes: [],
    ...over,
  });

  it("is white paper when the deck states no background", () => {
    expect(paperStyle(slide())).toBe("#ffffff");
  });

  it("is the colour the deck states", () => {
    expect(paperStyle(slide({ background: "#ececec" }))).toBe("#ececec");
  });

  it("covers the slide with the picture it states", () => {
    // A paper that is a photograph fills the slide, the way PowerPoint draws it.
    expect(paperStyle(slide({ backgroundImage: "data:image/png;base64,AA==" }))).toBe(
      'center / cover no-repeat url("data:image/png;base64,AA==")',
    );
  });

  it("is the gradient the deck states, drawn by the browser rather than approximated", () => {
    // The reader used to answer a gradient with its first stop, which turned this paper into flat
    // white; the value now says both stops and the angle.
    expect(
      paperStyle(slide({ backgroundGradient: "linear-gradient(180.0deg, #ffffff 0%, #d9d9d9 100%)" })),
    ).toBe("linear-gradient(180.0deg, #ffffff 0%, #d9d9d9 100%)");
  });
});
