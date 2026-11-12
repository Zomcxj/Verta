import { describe, expect, it } from "vitest";
import { imageScale } from "./imageScale";

describe("the scale a picture is drawn at", () => {
  const natural = { w: 2000, h: 1000 };
  const box = { w: 1000, h: 1000 };

  it("is the fit scale times the zoom, and the zoom alone at 1:1", () => {
    expect(imageScale({ fit: true, natural, box, zoom: 1 })).toBe(0.5);
    expect(imageScale({ fit: true, natural, box, zoom: 1.25 })).toBe(0.625);
    expect(imageScale({ fit: false, natural, box, zoom: 1 })).toBe(1);
    expect(imageScale({ fit: false, natural, box, zoom: 2 })).toBe(2);
  });

  it("fits by the axis that runs out first", () => {
    // A wide picture in a tall box is limited by the width, and the other way round.
    expect(imageScale({ fit: true, natural: { w: 4000, h: 500 }, box, zoom: 1 })).toBe(0.25);
    expect(imageScale({ fit: true, natural: { w: 500, h: 4000 }, box, zoom: 1 })).toBe(0.25);
  });

  it("scales up when the room is bigger than the picture", () => {
    // The two stops used to draw the same pixels in a big pane, which made the button the only way
    // to tell which one was on.
    expect(
      imageScale({ fit: true, natural: { w: 100, h: 100 }, box: { w: 400, h: 400 }, zoom: 1 }),
    ).toBe(4);
  });

  it("is unknown until the picture has reported its size", () => {
    // A picture still decoding has no size to scale from, and answering 1 would draw it wrong.
    expect(imageScale({ fit: true, natural: null, box, zoom: 1 })).toBeNull();
    expect(imageScale({ fit: false, natural: null, box, zoom: 1 })).toBeNull();
    expect(imageScale({ fit: true, natural: { w: 0, h: 0 }, box, zoom: 1 })).toBeNull();
  });

  it("is unknown while the room has not been measured", () => {
    // The observer reports on the first frame; before that there is no fit to compute.
    expect(imageScale({ fit: true, natural, box: null, zoom: 1 })).toBeNull();
    expect(imageScale({ fit: true, natural, box: { w: 0, h: 0 }, zoom: 1 })).toBeNull();
    // 1:1 does not need the room at all.
    expect(imageScale({ fit: false, natural, box: null, zoom: 1 })).toBe(1);
  });
});
