/**
 * 选区换算与调整：覆盖窗口里的 CSS 像素 ↔ 后端要的物理像素，以及框选之后怎么拖、怎么拉。
 *
 * 为什么要有这一层：覆盖窗口里量到的是 CSS 像素，而截图里要切的是物理像素。屏幕缩放到 125%
 * 时两者差一个 devicePixelRatio，直接把 CSS 坐标送过去就会切偏。
 *
 * 取整的规矩是「宁可多含，不要少给」：起点向下取、终点向上取，用户框住的那一列像素不该因为
 * 取整被丢掉。
 */

export type ScreenshotRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** 八个把手：四角 + 四边。 */
export type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

/** 选区最小边长（物理像素）：手一抖不该产生一张 1×1 的图。跟后端 `geom::MIN_SIDE` 对齐。 */
export const MIN_SIDE = 8;

type Pt = { x: number; y: number };
type Bounds = { width: number; height: number };

/** 拖拽的起点与终点（CSS 像素）→ 一块正着放的矩形。往回拖也一样。 */
export function rectFromDrag(start: Pt, end: Pt): ScreenshotRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

/** 整块挪动：尺寸不变，四条边都不许出画面（画面比选区还小时就贴着左上角）。 */
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
 * 拉某一个把手改尺寸：对面的边不动，撞到画面边就停在边上。
 *
 * 允许拉过头再拉回来（跟手），所以夹取之后可能反向——只用「不小于最小边长」兜底。
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

/** CSS 像素的矩形 → 后端要的物理像素选区。 */
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

/** 拖拽的起点与终点（CSS 像素）→ 后端要的选区。 */
export function selectionRect(
  start: Pt,
  end: Pt,
  dpr: number,
  bounds: Bounds,
): ScreenshotRect {
  return toPhysical(rectFromDrag(start, end), dpr, bounds);
}

/** 这块选区算不算选中：两边都得够大（按物理像素算，跟后端同一把尺子）。 */
export function isUsableSelection(rect: ScreenshotRect, dpr = 1): boolean {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return rect.width * scale >= MIN_SIDE && rect.height * scale >= MIN_SIDE;
}

/** 拖拽过程中画的那个框（CSS 像素）。 */
export function dragBox(
  start: Pt,
  end: Pt,
): { left: number; top: number; width: number; height: number } {
  const rect = rectFromDrag(start, end);
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

/** 把手在用哪个光标：让人一看就知道能往哪拉。 */
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
