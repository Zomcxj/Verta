/**
 * Where the details card sits for the row it is anchored to.
 *
 * The card is one element for the whole list, positioned with a `transform` rather than by being
 * mounted next to the row: switching rows moves it, which is the point - a panel that unmounts and
 * mounts again reads as a flicker rather than as a hand moving along the list. That means the
 * placement is arithmetic, and arithmetic is testable without a browser:
 *
 *  - it prefers the row's right side, which is where the row's own text ends;
 *  - when the card would run past the window's right edge it goes to the left of the row instead of
 *    being squeezed against the edge;
 *  - either way it stays inside the window: `x` is clamped between the margins, `y` too, so a row
 *    near the bottom of the list still shows its card above the status bar.
 *
 * The card's width comes from its own content and is measured before it is placed, so `y` never has
 * to reseat itself once the card is on screen.
 */
export type CardAnchor = { top: number; left: number; right: number };
export type CardSize = { width: number; height: number };
export type CardViewport = { width: number; height: number };

export type CardPlacement = { x: number; y: number; side: "left" | "right" };

/** The distance kept between the row and the card, and between the card and the window's edges. */
export const CARD_GAP = 8;
export const CARD_MARGIN = 8;

export function cardPlacement(
  anchor: CardAnchor,
  card: CardSize,
  viewport: CardViewport,
  gap: number = CARD_GAP,
  margin: number = CARD_MARGIN,
): CardPlacement {
  const rightX = anchor.right + gap;
  const fitsRight = rightX + card.width <= viewport.width - margin;
  const side: CardPlacement["side"] = fitsRight ? "right" : "left";
  const wanted = fitsRight ? rightX : anchor.left - gap - card.width;
  // A card wider than the window has no right answer; the left margin is the one that keeps its
  // first line readable.
  const maxX = Math.max(margin, viewport.width - card.width - margin);
  const x = Math.min(Math.max(wanted, margin), maxX);
  const maxY = Math.max(margin, viewport.height - card.height - margin);
  // The row is the anchor, not the pointer: the card's top tracks the row's top, so moving down a
  // list slides the card down by exactly one row.
  const y = Math.min(Math.max(anchor.top, margin), maxY);
  return { x, y, side };
}
