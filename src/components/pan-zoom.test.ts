import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { beginDrag, endDrag, moveDrag, zoomedBy, anchoredScroll } from "./pan-zoom";

const here = path.dirname(fileURLToPath(import.meta.url));
const surface = readFileSync(path.join(here, "pan-zoom.tsx"), "utf8");

describe("beginning a drag", () => {
  const base = { pointerId: 1, x: 10, y: 10, scrollLeft: 5, scrollTop: 7 };

  it("only starts on the primary button", () => {
    // A middle click is a paste on Windows and the secondary one belongs to the context menu.
    expect(beginDrag({ ...base, button: 0 })).toEqual({
      pointerId: 1,
      startX: 10,
      startY: 10,
      scrollLeft: 5,
      scrollTop: 7,
      moved: false,
    });
    expect(beginDrag({ ...base, button: 1 })).toBeNull();
    expect(beginDrag({ ...base, button: 2 })).toBeNull();
  });
});

describe("moving a drag", () => {
  const state = beginDrag({
    pointerId: 1,
    button: 0,
    x: 100,
    y: 100,
    scrollLeft: 40,
    scrollTop: 40,
  }) as NonNullable<ReturnType<typeof beginDrag>>;

  it("scrolls by the opposite of the pointer's travel, so the content follows the hand", () => {
    // Dragging right must reveal what is to the left: the scroll offset goes down.
    const moved = moveDrag(state, 70, 60);
    expect(moved.scrollLeft).toBe(70);
    expect(moved.scrollTop).toBe(80);
  });

  it("is not a drag until it has travelled past the threshold", () => {
    expect(moveDrag(state, 101, 101).state.moved).toBe(false);
    expect(moveDrag(state, 104, 100).state.moved).toBe(true);
  });

  it("stays a drag once it has become one, even if the pointer comes back", () => {
    // Otherwise a drag that ends where it started would click whatever is under it.
    const travelled = moveDrag(state, 140, 100).state;
    expect(moveDrag(travelled, 100, 100).state.moved).toBe(true);
  });
});

describe("ending a drag", () => {
  const state = beginDrag({
    pointerId: 1,
    button: 0,
    x: 0,
    y: 0,
    scrollLeft: 0,
    scrollTop: 0,
  }) as NonNullable<ReturnType<typeof beginDrag>>;

  it("swallows the click that follows a real drag, and only that one", () => {
    expect(endDrag(moveDrag(state, 30, 0).state)).toEqual({
      state: null,
      swallowClick: true,
    });
    expect(endDrag(state)).toEqual({ state: null, swallowClick: false });
  });
});

describe("a wheel asking for a new scale", () => {
  it("steps the same way the zoom controls do", () => {
    expect(zoomedBy(1, 1)).toBe(1.25);
    expect(zoomedBy(1, -1)).toBe(0.8);
  });
});

describe("where a zoom leaves the view", () => {
  it("holds the wheel's point still", () => {
    // The reader is looking at the middle-left of a drawing; the point under the pointer is the point
    // that has to stay under it. Content coordinates scale with the zoom, so the offset does too.
    const next = anchoredScroll({
      from: 1,
      to: 2,
      scrollLeft: 100,
      scrollTop: 40,
      point: { x: 200, y: 300 },
      viewport: { w: 1000, h: 800 },
    });
    // (100 + 200) * 2 - 200 and (40 + 300) * 2 - 300
    expect(next).toEqual({ scrollLeft: 400, scrollTop: 380 });
  });

  it("centres on the viewport when the control asked, not the wheel", () => {
    // A press of `+` has no pointer position that means anything - the pointer is over the control.
    const next = anchoredScroll({
      from: 1,
      to: 2,
      scrollLeft: 0,
      scrollTop: 0,
      point: null,
      viewport: { w: 1000, h: 800 },
    });
    expect(next).toEqual({ scrollLeft: 500, scrollTop: 400 });
  });

  it("is the same offset back again when the scale returns", () => {
    // Zooming in and out from the same point is a round trip: the doubling and the halving cancel, so
    // a drawing comes back where it was rather than drifting a little further each time.
    const point = { x: 320, y: 240 };
    const viewport = { w: 1000, h: 800 };
    const there = anchoredScroll({ from: 1, to: 2, scrollLeft: 60, scrollTop: 20, point, viewport });
    const back = anchoredScroll({ from: 2, to: 1, ...there, point, viewport });
    expect(back.scrollLeft).toBeCloseTo(60, 6);
    expect(back.scrollTop).toBeCloseTo(20, 6);
  });

  it("leaves the offset alone when the scale did not move", () => {
    expect(
      anchoredScroll({
        from: 1,
        to: 1,
        scrollLeft: 42,
        scrollTop: 7,
        point: { x: 10, y: 10 },
        viewport: { w: 100, h: 100 },
      }),
    ).toEqual({ scrollLeft: 42, scrollTop: 7 });
  });
});

describe("the surface", () => {
  it("starts a drag from the primary button and keeps the pointer captured", () => {
    // Captured so the gesture survives the pointer leaving the element: dragging a picture whose
    // edge is at the window's edge is the normal case, not the exception.
    expect(surface).toMatch(/onPointerDown=/);
    expect(surface).toMatch(/setPointerCapture\(/);
    expect(surface).toMatch(/releasePointerCapture\(/);
    expect(surface).toMatch(/beginDrag\(\{/);
  });

  it("writes the offsets to the scrollport rather than transforming the content", () => {
    // The scrollport already knows how far its content can move, so its own range is the limit - a
    // drag can never put part of the content where no scroll reaches.
    expect(surface).toMatch(/viewport\.scrollLeft = next\.scrollLeft/);
    expect(surface).toMatch(/viewport\.scrollTop = next\.scrollTop/);
    expect(surface).not.toMatch(/style\.transform/);
  });

  it("swallows the click that ends a drag", () => {
    expect(surface).toMatch(/onClickCapture=/);
    expect(surface).toMatch(/swallowClickRef\.current/);
    expect(surface).toMatch(/stopPropagation\(\)/);
  });

  it("does not let a draggable child start a drag of its own", () => {
    // An `<img>` drags itself by default, and that drag takes the gesture away: the webview paints a
    // ghost, the moves stop arriving and the pane does not move - the left button "does nothing" on a
    // picture, and works on a drawing.
    expect(surface).toMatch(/onDragStart=\{onDragStart\}/);
    expect(surface).toMatch(/if \(draggable\) event\.preventDefault\(\)/);
  });

  it("holds the point being looked at still across a zoom", () => {
    // Without this the scrollport keeps its offset, which is 0 until the content overflows: every zoom
    // showed the same top-left corner, and zooming read as "it only grows downwards and rightwards".
    expect(surface).toMatch(/anchoredScroll\(\{/);
    expect(surface).toMatch(/wheelPointRef\.current = \{ x: event\.clientX - rect\.left/);
    expect(surface).toMatch(/viewport\.addEventListener\("scroll", remember/);
  });

  it("takes ctrl+wheel itself, because React's wheel listener is passive", () => {
    expect(surface).toMatch(
      /addEventListener\("wheel", onWheel, \{ passive: false \}\)/,
    );
    expect(surface).toMatch(/onZoomChange\(next\)/);
    expect(surface).toMatch(/const next = zoomedBy\(zoom, event\.deltaY < 0 \? 1 : -1\)/);
  });

  it("centres safely in both axes, so nothing can overflow past the scroll origin", () => {
    expect(surface).toMatch(/\[align-items:safe_center\]/);
    expect(surface).toMatch(/\[justify-content:safe_center\]/);
  });

  it("says it is draggable with the cursor, and only while it is", () => {
    expect(surface).toMatch(/draggable && \(dragging \? "cursor-grabbing" : "cursor-grab"\)/);
  });
});
