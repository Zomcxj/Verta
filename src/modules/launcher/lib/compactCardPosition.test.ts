import { describe, expect, it } from "vitest";
import { compactCardPlacement } from "./compactCardPosition";

const card = { width: 288, height: 96 };
const viewport = { width: 1440, height: 900 };

describe("the roaming details card's placement", () => {
  it("sits to the right of its row", () => {
    const anchor = { top: 120, left: 40, right: 320 };
    expect(compactCardPlacement(anchor, card, viewport)).toEqual({
      x: 328,
      y: 120,
      side: "right",
    });
  });

  it("follows the row down the list by exactly one row", () => {
    const first = compactCardPlacement(
      { top: 120, left: 40, right: 320 },
      card,
      viewport,
    );
    const second = compactCardPlacement(
      { top: 154, left: 40, right: 320 },
      card,
      viewport,
    );
    expect(second.y - first.y).toBe(34);
    expect(second.x).toBe(first.x);
  });

  it("goes to the left of the row when there is no room on the right", () => {
    // A narrow window: the card would end past the right edge.
    const narrow = { width: 700, height: 900 };
    const anchor = { top: 200, left: 380, right: 660 };
    expect(compactCardPlacement(anchor, card, narrow)).toEqual({
      x: 84,
      y: 200,
      side: "left",
    });
  });

  it("flips sides earlier for a wider card, because the width comes from its content", () => {
    // A window narrow enough that the row's right side has room for a short card and not for a
    // longer one - which is the same row, since the width is the card's own.
    const narrowWindow = { width: 860, height: 900 };
    const anchor = { top: 120, left: 40, right: 560 };
    const shortCard = { width: 208, height: 96 };
    const longCard = { width: 304, height: 96 };
    expect(compactCardPlacement(anchor, shortCard, narrowWindow).side).toBe(
      "right",
    );
    expect(compactCardPlacement(anchor, longCard, narrowWindow).side).toBe(
      "left",
    );
  });

  it("keeps a card that does not fit either side inside the margin", () => {
    const tiny = { width: 200, height: 400 };
    const anchor = { top: 40, left: 20, right: 180 };
    const placed = compactCardPlacement(anchor, card, tiny);
    expect(placed.x).toBe(8);
    expect(placed.side).toBe("left");
  });

  it("lifts a card off the bottom edge for a row near the end of the list", () => {
    const anchor = { top: 860, left: 40, right: 320 };
    const placed = compactCardPlacement(anchor, card, viewport);
    expect(placed.y).toBe(viewport.height - card.height - 8);
    expect(placed.y).toBeLessThan(anchor.top);
  });

  it("does not push a card below the top margin for a row scrolled above the window", () => {
    const placed = compactCardPlacement(
      { top: -40, left: 40, right: 320 },
      card,
      viewport,
    );
    expect(placed.y).toBe(8);
  });
});
