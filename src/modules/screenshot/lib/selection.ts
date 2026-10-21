/**
 * 选区换算：覆盖窗口里的 CSS 像素 ↔ 后端要的物理像素。
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

/** 选区最小边长（物理像素）：手一抖不该产生一张 1×1 的图。跟后端 `geom::MIN_SIDE` 对齐。 */
export const MIN_SIDE = 8;

/** 拖拽的起点与终点（CSS 像素，相对覆盖窗口左上角）→ 后端要的选区。 */
export function selectionRect(
  start: { x: number; y: number },
  end: { x: number; y: number },
  dpr: number,
  bounds: { width: number; height: number },
): ScreenshotRect {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const left = clamp(Math.floor(Math.min(start.x, end.x) * scale), 0, bounds.width);
  const top = clamp(Math.floor(Math.min(start.y, end.y) * scale), 0, bounds.height);
  const right = clamp(Math.ceil(Math.max(start.x, end.x) * scale), 0, bounds.width);
  const bottom = clamp(Math.ceil(Math.max(start.y, end.y) * scale), 0, bounds.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 这块选区算不算选中：两边都得够大。 */
export function isUsableSelection(rect: ScreenshotRect): boolean {
  return rect.width >= MIN_SIDE && rect.height >= MIN_SIDE;
}

/** 拖拽过程中画的那个框（CSS 像素）。 */
export function dragBox(
  start: { x: number; y: number },
  end: { x: number; y: number },
): { left: number; top: number; width: number; height: number } {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(Math.max(value, low), high);
}