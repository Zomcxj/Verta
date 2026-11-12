/**
 * How far one press of a diagram's zoom control moves it.
 *
 * Multiplicative, and the same numbers the slide preview uses, so "one press" means the same thing
 * wherever a preview has a zoom: a quarter larger per press, four presses to roughly double.
 */
export const ZOOM_STEP = 1.25;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;

/** The zoom one press moves to, clamped at both ends and rounded for the label. */
export function steppedZoom(current: number, direction: 1 | -1): number {
  const next = direction > 0 ? current * ZOOM_STEP : current / ZOOM_STEP;
  return Math.round(Math.min(Math.max(next, MIN_ZOOM), MAX_ZOOM) * 100) / 100;
}

/** `125%`, `80%` - the number the control shows. */
export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/**
 * The drawing at a magnification.
 *
 * At 1 the svg is left as mermaid wrote it - `width: 100%` capped at the drawing's own width - which
 * is how a diagram opens: as wide as the pane, never wider than the drawing. Away from 1 the size is
 * explicit rather than a transform, so the pane scrolls to the rest of the drawing instead of
 * squeezing it, and a press lands somewhere the reader can still read.
 *
 * The natural width comes from the `viewBox` rather than from the rendered box: the rendered one is
 * already scaled, so reading it back would make every press depend on the one before it.
 */
export function applyDiagramZoom(svg: SVGElement, zoom: number): void {
  const natural = (svg as SVGSVGElement).viewBox?.baseVal?.width ?? 0;
  if (!natural) return;
  if (zoom === 1) {
    svg.style.removeProperty("width");
    svg.style.setProperty("max-width", `${natural}px`);
    return;
  }
  svg.style.setProperty("width", `${natural * zoom}px`);
  svg.style.setProperty("max-width", "none");
}
