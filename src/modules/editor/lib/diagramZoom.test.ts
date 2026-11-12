import { describe, expect, it } from "vitest";
import {
  applyDiagramZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  steppedZoom,
  zoomLabel,
  ZOOM_STEP,
} from "./diagramZoom";

/** The two style methods the sizing uses, on an svg with a viewBox and nothing else. */
function fakeSvg(natural: number) {
  const style = new Map<string, string>();
  const svg = {
    viewBox: { baseVal: { width: natural } },
    style: {
      setProperty: (key: string, value: string) => style.set(key, value),
      removeProperty: (key: string) => style.delete(key),
    },
  } as unknown as SVGElement;
  return { svg, style };
}

describe("stepping a diagram's zoom", () => {
  it("moves by the same factor the slide preview uses, so one press means one thing", () => {
    expect(ZOOM_STEP).toBe(1.25);
    expect(steppedZoom(1, 1)).toBe(1.25);
    expect(steppedZoom(1, -1)).toBe(0.8);
    expect(steppedZoom(1.25, 1)).toBe(1.56);
  });

  it("stops at both ends instead of wrapping or creeping past them", () => {
    expect(steppedZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(steppedZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    expect(steppedZoom(3.9, 1)).toBe(MAX_ZOOM);
  });

  it("reads as the percentage the control shows", () => {
    expect(zoomLabel(1)).toBe("100%");
    expect(zoomLabel(1.25)).toBe("125%");
    expect(zoomLabel(0.8)).toBe("80%");
  });
});

describe("sizing the drawing", () => {
  it("leaves mermaid's own sizing on at 100%, which is 'fit the pane, up to the drawing'", () => {
    const { svg, style } = fakeSvg(360);
    style.set("width", "450px");
    applyDiagramZoom(svg, 1);
    expect(style.has("width")).toBe(false);
    expect(style.get("max-width")).toBe("360px");
  });

  it("gives the drawing an explicit size away from 100%, so the pane scrolls instead of squeezing", () => {
    const larger = fakeSvg(360);
    applyDiagramZoom(larger.svg, 1.25);
    expect(larger.style.get("width")).toBe("450px");
    expect(larger.style.get("max-width")).toBe("none");

    const smaller = fakeSvg(360);
    applyDiagramZoom(smaller.svg, 0.5);
    expect(smaller.style.get("width")).toBe("180px");
    expect(smaller.style.get("max-width")).toBe("none");
  });

  it("takes the size from the viewBox, not from the box already on screen", () => {
    // Reading the rendered box would make each press depend on the one before it: 360 -> 450 -> 562
    // instead of 450 again.
    const { svg, style } = fakeSvg(360);
    applyDiagramZoom(svg, 1.25);
    const first = style.get("width");
    applyDiagramZoom(svg, 1.25);
    expect(first).toBe("450px");
    expect(style.get("width")).toBe("450px");
  });

  it("does nothing to a drawing that has no viewBox to measure", () => {
    const { svg, style } = fakeSvg(0);
    applyDiagramZoom(svg, 2);
    expect(style.size).toBe(0);
  });
});
