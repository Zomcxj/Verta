/**
 * Selection conversion and adjustment: CSS pixels in the overlay ↔ physical pixels
 * for the backend, plus how a selection is dragged and resized.
 *
 * Why this layer exists: the overlay measures CSS pixels while the capture crops
 * physical pixels. At 125% display scaling the two differ by a devicePixelRatio,
 * so passing CSS coordinates straight through crops off target.
 *
 * Rounding leans toward including rather than cutting: floor the start, ceil the
 * end, so the last row of pixels the user enclosed is never lost to rounding.
 */

export type ScreenshotRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Eight handles: four corners plus four edges. */
export type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

/** Minimum side of a selection (physical pixels) so a twitchy hand cannot produce a
 * 1×1 image. Matches `geom::MIN_SIDE` in the backend. */
export const MIN_SIDE = 8;

type Pt = { x: number; y: number };
type Bounds = { width: number; height: number };

/** Drag start and end (CSS pixels) → a properly oriented rect. Dragging backwards works too. */
export function rectFromDrag(start: Pt, end: Pt): ScreenshotRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

/** Move the whole rect: size unchanged, no edge may leave the viewport (if the
 * viewport is smaller than the rect, it hugs the top-left). */
export function moveRect(
  rect: ScreenshotRect,
  dx: number,
  dy: number,
  bounds: Bounds,
): ScreenshotRect {
  const width = Math.min(rect.width, bounds.width);
  const height = Math.min(rect.height, bounds.height);
  return {
    x: clamp(rect.x + dx, 0, Math.max(0, bounds.width - width)),
    y: clamp(rect.y + dy, 0, Math.max(0, bounds.height - height)),
    width,
    height,
  };
}

/**
 * Resize by one handle: the opposite edge stays put, and hitting the viewport edge
 * stops there.
 *
 * Overshooting and coming back is allowed (it tracks the cursor), so clamping can
 * flip the direction; the minimum side is the only guard.
 */
export function resizeRect(
  rect: ScreenshotRect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  bounds: Bounds,
  minimum = MIN_SIDE,
): ScreenshotRect {
  const minWidth = Math.min(minimum, bounds.width);
  const minHeight = Math.min(minimum, bounds.height);
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;

  if (handle.includes("w")) left = clamp(left + dx, 0, right - minWidth);
  if (handle.includes("e"))
    right = clamp(right + dx, left + minWidth, bounds.width);
  if (handle.includes("n")) top = clamp(top + dy, 0, bottom - minHeight);
  if (handle.includes("s"))
    bottom = clamp(bottom + dy, top + minHeight, bounds.height);

  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** CSS-pixel rect → the physical-pixel selection the backend wants. */
export function toPhysical(
  rect: ScreenshotRect,
  dpr: number,
  bounds: Bounds,
): ScreenshotRect {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const left = clamp(Math.floor(rect.x * scale), 0, bounds.width);
  const top = clamp(Math.floor(rect.y * scale), 0, bounds.height);
  const right = clamp(
    Math.ceil((rect.x + rect.width) * scale),
    0,
    bounds.width,
  );
  const bottom = clamp(
    Math.ceil((rect.y + rect.height) * scale),
    0,
    bounds.height,
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Drag start and end (CSS pixels) → the selection the backend wants. */
export function selectionRect(
  start: Pt,
  end: Pt,
  dpr: number,
  bounds: Bounds,
): ScreenshotRect {
  return toPhysical(rectFromDrag(start, end), dpr, bounds);
}

/** Whether this selection counts: both sides must be big enough (measured in
 * physical pixels, the same ruler the backend uses). */
export function isUsableSelection(rect: ScreenshotRect, dpr = 1): boolean {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return rect.width * scale >= MIN_SIDE && rect.height * scale >= MIN_SIDE;
}

/** The box drawn during a drag (CSS pixels). */
export function dragBox(
  start: Pt,
  end: Pt,
): { left: number; top: number; width: number; height: number } {
  const rect = rectFromDrag(start, end);
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

/** Cursor for a handle, so it is obvious which way it drags. */
export function handleCursor(handle: ResizeHandle): string {
  switch (handle) {
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    default:
      return "nwse-resize";
  }
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(Math.max(value, low), high);
}
