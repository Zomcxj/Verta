/**
 * The scale a picture is drawn at.
 *
 * Two stops and a magnification over them: `fit` scales the picture to the room it has (up as well as
 * down - capping it at its own size made the two modes draw the same pixels whenever the pane was
 * bigger than the picture), and the zoom multiplies that. With `fit` off the scale is the zoom alone,
 * so 100% means the picture's own pixels, which is the number worth having for a picture and means
 * nothing for a diagram.
 *
 * `null` while the natural size is unknown: a picture still decoding has no size to scale from, and
 * answering 1 would draw it at the wrong size for a frame.
 */
export function imageScale(input: {
  fit: boolean;
  natural: { w: number; h: number } | null;
  box: { w: number; h: number } | null;
  zoom: number;
}): number | null {
  const { fit, natural, box, zoom } = input;
  if (!natural || natural.w <= 0 || natural.h <= 0) return null;
  if (!fit) return zoom;
  if (!box || box.w <= 0 || box.h <= 0) return null;
  return Math.min(box.w / natural.w, box.h / natural.h) * zoom;
}
