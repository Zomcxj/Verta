import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The picture preview, read as source.
 *
 * Two things here are rules the preview learned the hard way and can only be seen in its markup: the
 * size is the picture's own rather than something the pane clamps, and the scrollport it is measured
 * against is the one the shared surface actually renders. Both were measured as bugs on a real
 * picture before they were written down.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const pane = readFileSync(path.join(here, "EditorPane.tsx"), "utf8");

/** The `<img>` of the picture preview, which is the only one in the module. */
const marker = pane.indexOf("src={src}");
const picture =
  marker < 0
    ? ""
    : pane.slice(pane.lastIndexOf("<img", marker), pane.indexOf("/>", marker) + 2);

describe("the picture's own size", () => {
  it("is not clamped to the pane, so a magnification can be wider than it", () => {
    // The base layer caps every image at its container's width. Leaving that cap on clamps the width
    // while the height keeps growing, so a magnification stretched the picture instead of enlarging
    // it - reported from a real pane as "zoom only makes it taller". `max-w-none` is what lifts it,
    // and it has to hold at both stops: at the fit stop the cap is unnecessary anyway, because the
    // size is already the smaller of the two ratios.
    expect(picture).toMatch(/max-w-none/);
    expect(picture).not.toMatch(/fit\s*\n?\s*\?\s*"rounded-md border/);
  });

  it("is floored rather than clipped, and never collapses to nothing", () => {
    expect(pane).toMatch(/Math\.max\(1, Math\.floor\(size\.w \* scale\)\)/);
    expect(pane).toMatch(/Math\.max\(1, Math\.floor\(size\.h \* scale\)\)/);
    // The clamp that made `+` a no-op in the fit stop.
    expect(pane).not.toMatch(/Math\.min\(Math\.floor\(box\.w\)/);
  });

  it("is read from the element on mount as well as from `load`", () => {
    // A picture already decoded when React attached its handler never raises `load`: with only the
    // event, nothing knows how big the picture is and nothing can fit it - measured as a 3072px
    // screenshot drawn at 3074px in a 1070px pane.
    expect(pane).toMatch(/img\?\.complete \|\| img\.naturalWidth === 0/);
    expect(pane).toMatch(/readNaturalSize\(picture\.current\)/);
    expect(picture).toMatch(/ref=\{picture\}/);
    expect(picture).toMatch(
      /onLoad=\{\(event\) => readNaturalSize\(event\.currentTarget\)\}/,
    );
  });

  it("comes from the tested rule rather than a second copy of it", () => {
    expect(pane).toMatch(/imageScale\(\{ fit, natural: size, box, zoom \}\)/);
  });
});

describe("the picture's room", () => {
  it("is measured on the surface's own scrollport, handed in rather than looked for", () => {
    // The ref used to be on a plain wrapper that the surface replaced, so the observer watched
    // nothing, the room was never known and the fit none of it: a tall picture was drawn at its own
    // size inside a pane half as tall.
    expect(pane).toMatch(/<PanZoomSurface\s+viewportRef=\{viewport\}/);
  });

  it("is measured from the element, on the frames the pane is not laid out yet", () => {
    // A pane that has not been laid out reports *nothing* to a resize observer, not even a zero - so a
    // picture opened into a pane the workspace was still switching to had a size, an observer and no
    // room: the fit was never computed and the picture opened at its own pixels.
    expect(pane).toMatch(/if \(node\) measureRoom\(node\)/);
    expect(pane).toMatch(/requestAnimationFrame\(function tick\(\)/);
    expect(pane).toMatch(/rememberRoom\(\{ w: rect\.width, h: rect\.height \}\)/);
    // Zero is not a room: a not-yet-laid-out pane must not be fitted against nothing.
    expect(pane).toMatch(/if \(room\.w <= 0 \|\| room\.h <= 0\) return;/);
  });

  it("drags with the shared surface, and only once it is bigger than the room", () => {
    expect(pane).toMatch(/draggable=\{drawn !== null && box !== null/);
  });
});

describe("the picture's zoom", () => {
  it("is the same control a diagram uses, and either stop resets it", () => {
    expect(pane).toMatch(/<ZoomControls zoom=\{zoom\} onChange=\{setZoom\} \/>/);
    // Carrying a magnification across would make "fit" not fit and "1:1" not 1:1.
    expect(pane).toMatch(/setFit\(\(was\) => !was\);\s*\n\s*setZoom\(1\);/);
  });
});
