import type { TerminalFontMetrics } from "./terminalVisuals";

const MIN_COLUMNS = 2;
const MAX_COLUMNS = 512;
const MIN_ROWS = 1;
const MAX_ROWS = 256;
const DEVICE_ROUNDING_TOLERANCE_PX = 0.02;

export type TerminalDeviceBounds = {
  readonly width: number;
  readonly height: number;
};

export type TerminalViewportFit = {
  readonly cols: number;
  readonly rows: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
};

/**
 * Fits whole integer device cells into a host box. `deviceBounds` is the exact
 * device-pixel content box from `ResizeObserver` when the engine reports it;
 * otherwise the CSS size is converted and rounded. The CSS size of the result
 * is the device size divided by the ratio, so a canvas styled with it maps
 * 1:1 onto the device pixel grid.
 */
export function fitTerminalViewport(
  hostWidth: number,
  hostHeight: number,
  metrics: TerminalFontMetrics,
  deviceBounds?: TerminalDeviceBounds | null,
): TerminalViewportFit | null {
  const { deviceCellWidth, deviceCellHeight, scale } = metrics;
  if (
    !isPositiveFinite(hostWidth) ||
    !isPositiveFinite(hostHeight) ||
    !isPositiveFinite(deviceCellWidth) ||
    !isPositiveFinite(deviceCellHeight) ||
    !isPositiveFinite(scale)
  ) {
    return null;
  }
  const deviceWidth = deviceBounds?.width ?? hostWidth * scale;
  const deviceHeight = deviceBounds?.height ?? hostHeight * scale;
  if (
    deviceWidth + DEVICE_ROUNDING_TOLERANCE_PX <
      MIN_COLUMNS * deviceCellWidth ||
    deviceHeight + DEVICE_ROUNDING_TOLERANCE_PX < MIN_ROWS * deviceCellHeight
  ) {
    return null;
  }

  const cols = clamp(
    Math.floor((deviceWidth + DEVICE_ROUNDING_TOLERANCE_PX) / deviceCellWidth),
    MIN_COLUMNS,
    MAX_COLUMNS,
  );
  const rows = clamp(
    Math.floor(
      (deviceHeight + DEVICE_ROUNDING_TOLERANCE_PX) / deviceCellHeight,
    ),
    MIN_ROWS,
    MAX_ROWS,
  );
  const { width: pixelWidth, height: pixelHeight } = gridDeviceSize(
    cols,
    rows,
    metrics,
  );
  return {
    cols,
    rows,
    cssWidth: pixelWidth / scale,
    cssHeight: pixelHeight / scale,
    pixelWidth,
    pixelHeight,
  };
}

/**
 * Device-pixel rectangle a cell grid covers, the area a renderer draws its cells across.
 *
 * A renderer's canvas is often larger than this: the backing store reuses a nearby bigger
 * canvas instead of reallocating the swapchain on every resize step, and the surplus is
 * cleared to the background and clipped by the host. The cells still belong in exactly this
 * rectangle. Spreading the grid over the whole canvas would tie the cell pitch to the canvas
 * size, and the canvas size follows the pane size, so letter spacing and row height would
 * change as a pane is dragged apart.
 */
export function gridDeviceSize(
  cols: number,
  rows: number,
  metrics: Pick<TerminalFontMetrics, "deviceCellWidth" | "deviceCellHeight">,
): { readonly width: number; readonly height: number } {
  return {
    width: Math.max(1, cols * metrics.deviceCellWidth),
    height: Math.max(1, rows * metrics.deviceCellHeight),
  };
}

/**
 * The viewport rectangle a renderer's grid owns inside its own canvas.
 *
 * WebGL measures a viewport's origin from the bottom-left of the canvas, and the backing store
 * keeps a canvas bigger than the grid on purpose. Handing it `0` for `y` would leave the grid at
 * the bottom of that surplus instead of where the host puts it, so the cells would be drawn lower
 * than the CSS space the rest of the app positions text, selection and pictures in (the pane's
 * top-left). The grid belongs at the canvas' top-left, whatever the surplus.
 */
export function gridViewportRect(
  canvasHeight: number,
  gridWidth: number,
  gridHeight: number,
): {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
} {
  return {
    x: 0,
    y: Math.max(0, Math.round(canvasHeight) - Math.round(gridHeight)),
    width: gridWidth,
    height: gridHeight,
  };
}

/**
 * CSS translation that moves an element whose layout origin is `left`/`top`
 * onto the nearest device pixel boundary. Zero when already aligned.
 */
export function snapOffsetCss(
  left: number,
  top: number,
  scale: number,
): { readonly x: number; readonly y: number } {
  return { x: snapAxis(left, scale), y: snapAxis(top, scale) };
}

function snapAxis(origin: number, scale: number): number {
  if (!Number.isFinite(origin) || !isPositiveFinite(scale)) return 0;
  const device = origin * scale;
  const offset = (Math.round(device) - device) / scale;
  return Math.abs(offset * scale) < 1e-6 ? 0 : offset;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
