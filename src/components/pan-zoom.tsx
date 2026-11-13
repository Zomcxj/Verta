"use client";

import { cn } from "@/lib/utils";
import { steppedZoom } from "@/modules/editor/lib/diagramZoom";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Dragging a picture or a drawing, expressed as scroll offsets.
 *
 * Not as a transform: the scrollport already knows how far its content can move, so writing
 * `scrollLeft`/`scrollTop` makes the browser's own range the limit. A drag can therefore never put
 * part of the content somewhere no scroll can reach - which is exactly what a transform does when
 * the pointer outruns the edge and what leaves a drawing's corner permanently lost.
 *
 * The numbers are pure and tested on their own; the component below is the wiring.
 */
export type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
  /** Whether this gesture has travelled far enough to count as a drag rather than a click. */
  moved: boolean;
};

/** How far the pointer has to travel before a press is a drag; below it, it is still a click. */
const DRAG_THRESHOLD = 3;

/** A press that starts a drag, or `null` for a button that does not. */
export function beginDrag(input: {
  pointerId: number;
  button: number;
  x: number;
  y: number;
  scrollLeft: number;
  scrollTop: number;
}): DragState | null {
  // The primary button only: a middle click is a paste on Windows and the secondary one belongs to
  // the context menu.
  if (input.button !== 0) return null;
  return {
    pointerId: input.pointerId,
    startX: input.x,
    startY: input.y,
    scrollLeft: input.scrollLeft,
    scrollTop: input.scrollTop,
    moved: false,
  };
}

/**
 * Where the scrollport should be for a pointer at `(x, y)`.
 *
 * The content follows the hand, so the offset moves the opposite way from the pointer: dragging
 * right reveals what is to the left, which is a smaller `scrollLeft`.
 */
export function moveDrag(
  state: DragState,
  x: number,
  y: number,
  threshold: number = DRAG_THRESHOLD,
): { state: DragState; scrollLeft: number; scrollTop: number } {
  const dx = x - state.startX;
  const dy = y - state.startY;
  const moved =
    state.moved || Math.abs(dx) > threshold || Math.abs(dy) > threshold;
  return {
    state: { ...state, moved },
    scrollLeft: state.scrollLeft - dx,
    scrollTop: state.scrollTop - dy,
  };
}

/**
 * The end of a gesture, and whether the click that follows it belongs to the drag.
 *
 * A pointer that moved was not clicking: without this the drawing under the pointer would receive a
 * click at the end of every drag.
 */
export function endDrag(state: DragState): {
  state: null;
  swallowClick: boolean;
} {
  return { state: null, swallowClick: state.moved };
}

/** The scale a ctrl/cmd + wheel asks for, stepping the same way the zoom controls do. */
export function zoomedBy(zoom: number, direction: 1 | -1): number {
  return steppedZoom(zoom, direction);
}

/**
 * Where the scrollport belongs after a zoom, so the point being looked at stays where it is.
 *
 * The point is in the scrollport's own coordinates - a wheel's position, or the middle of the viewport
 * for the zoom control. Content coordinates scale with the zoom, so the offset that puts the same
 * content point back under the same place is the old offset scaled by the ratio. Without this the
 * scrollport keeps the offset it had, which at 0 is the content's top-left corner: every press of `+`
 * on a drawing that is wider than its pane would then show the same corner, and zooming would read as
 * "it only grows downwards and rightwards" rather than "it comes closer".
 */
export function anchoredScroll(input: {
  /** The scale that was in force. */
  from: number;
  /** The scale going in force. */
  to: number;
  scrollLeft: number;
  scrollTop: number;
  /** The point to hold still; the middle of the viewport when there is none (a button, not a wheel). */
  point?: { x: number; y: number } | null;
  viewport: { w: number; h: number };
}): { scrollLeft: number; scrollTop: number } {
  const ratio = input.from > 0 ? input.to / input.from : 1;
  const x = input.point?.x ?? input.viewport.w / 2;
  const y = input.point?.y ?? input.viewport.h / 2;
  return {
    scrollLeft: (input.scrollLeft + x) * ratio - x,
    scrollTop: (input.scrollTop + y) * ratio - y,
  };
}

/**
 * The scrollport both a picture and a diagram are looked at through.
 *
 * It owns the scrolling, the drag and the ctrl/cmd + wheel; the content owns its own size, because
 * only the content knows what its scale means - a diagram's 100% is its `viewBox`, a picture's is its
 * own pixels.
 */
export function PanZoomSurface({
  zoom,
  onZoomChange,
  draggable,
  className,
  children,
  viewportRef,
}: {
  /** The scale in force, so a wheel knows what to step from. */
  zoom: number;
  /** Without this the wheel is left to the pane, which is what a block inside a message wants. */
  onZoomChange?: (zoom: number) => void;
  /** Whether the content is bigger than the scrollport in either axis; it decides the cursor. */
  draggable: boolean;
  className?: string;
  children: ReactNode;
  /**
   * The scrollport itself, for a caller that has to measure the room content has.
   *
   * A picture needs it before it can be fitted: the scale is the room over the picture's own size,
   * and the room is this element's content box. Handed in rather than reported because a resize
   * observer wants the element, and the element is only knowable from inside here.
   */
  viewportRef?: RefObject<HTMLDivElement | null>;
}) {
  const ownRef = useRef<HTMLDivElement | null>(null);
  const viewportRef_ = viewportRef ?? ownRef;
  const dragRef = useRef<DragState | null>(null);
  const swallowClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  /**
   * Where the content is being looked at, kept current so a zoom has something to anchor against.
   *
   * Read continuously rather than once per gesture: the zoom can be asked for from the control as well
   * as from the wheel, and by then the pointer is over the control, not the content.
   */
  const geometryRef = useRef({ scrollLeft: 0, scrollTop: 0, w: 0, h: 0 });
  /** The point a wheel asked to hold still, until the zoom that follows has been applied. */
  const wheelPointRef = useRef<{ x: number; y: number } | null>(null);
  const zoomRef = useRef(zoom);

  // The scrollport's own numbers, kept current. A `scroll` listener covers a drag and the wheel; the
  // size is read here too because a zoom can change it (a scrollbar appearing takes 15px off the room).
  useEffect(() => {
    const viewport = viewportRef_.current;
    if (!viewport) return;
    const remember = () => {
      geometryRef.current = {
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
        w: viewport.clientWidth,
        h: viewport.clientHeight,
      };
    };
    remember();
    viewport.addEventListener("scroll", remember, { passive: true });
    return () => viewport.removeEventListener("scroll", remember);
  }, [viewportRef_]);

  /**
   * A zoom keeps the point the reader is looking at where it is.
   *
   * Applied on a couple of frames as well as immediately: the content sizes itself in its own render
   * (an inline width, or a drawing sized from its `viewBox` in an effect of its own), so the frame the
   * offsets are written in may still be the old layout. Writing a target rather than a delta makes
   * that harmless - the later frames write the same numbers.
   */
  // The effect is keyed on the scale and reads the geometry through a ref on purpose: making the
  // geometry a dependency would re-anchor the view on every scroll.
  useEffect(() => {
    const viewport = viewportRef_.current;
    const from = zoomRef.current;
    zoomRef.current = zoom;
    if (!viewport || from === zoom) return;
    const geometry = geometryRef.current;
    const next = anchoredScroll({
      from,
      to: zoom,
      scrollLeft: geometry.scrollLeft,
      scrollTop: geometry.scrollTop,
      point: wheelPointRef.current,
      // The size read live: the room is what a button zoom centres in, and it is not the number that
      // changes with the content (a scrollbar appearing does take part of it).
      viewport: { w: viewport.clientWidth, h: viewport.clientHeight },
    });
    wheelPointRef.current = null;
    const apply = () => {
      viewport.scrollLeft = next.scrollLeft;
      viewport.scrollTop = next.scrollTop;
    };
    apply();
    requestAnimationFrame(() => {
      apply();
      requestAnimationFrame(apply);
    });
  }, [zoom, viewportRef_]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggable) return;
      const viewport = viewportRef_.current;
      if (!viewport) return;
      const state = beginDrag({
        pointerId: event.pointerId,
        button: event.button,
        x: event.clientX,
        y: event.clientY,
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
      });
      if (!state) return;
      dragRef.current = state;
      setDragging(true);
      // Captured so the gesture survives the pointer leaving the element - dragging a picture whose
      // edge is at the window's edge is the normal case, not the exception.
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [draggable, viewportRef_],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = dragRef.current;
      const viewport = viewportRef_.current;
      if (!state || !viewport || state.pointerId !== event.pointerId) return;
      const next = moveDrag(state, event.clientX, event.clientY);
      dragRef.current = next.state;
      viewport.scrollLeft = next.scrollLeft;
      viewport.scrollTop = next.scrollTop;
    },
    [viewportRef_],
  );

  const finishDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = dragRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      const ended = endDrag(state);
      dragRef.current = ended.state;
      swallowClickRef.current = ended.swallowClick;
      setDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  // A click that ends a drag belongs to the drag. Captured on the way down, before anything inside
  // the content can act on it.
  const onClickCapture = useCallback((event: React.MouseEvent) => {
    if (!swallowClickRef.current) return;
    swallowClickRef.current = false;
    event.stopPropagation();
    event.preventDefault();
  }, []);

  /**
   * A natively draggable child does not get to start a drag.
   *
   * An `<img>` (and a link) drags itself by default, and a drag of its own takes the gesture away from
   * this surface: the webview paints a ghost of the picture, stops delivering the moves, and the pane
   * simply does not move - reported as "the left button does nothing on a picture". Cancelling
   * `dragstart` inside the surface leaves the gesture where it belongs.
   */
  const onDragStart = useCallback(
    (event: React.DragEvent) => {
      if (draggable) event.preventDefault();
    },
    [draggable],
  );

  useEffect(() => {
    const viewport = viewportRef_.current;
    if (!viewport || !onZoomChange) return;
    // Ctrl/cmd + wheel, the gesture a viewer is expected to have. Attached by hand and marked
    // non-passive: React's own wheel listener is passive, so `preventDefault` there would do nothing
    // and the webview would zoom the whole window instead of the content.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const next = zoomedBy(zoom, event.deltaY < 0 ? 1 : -1);
      if (next === zoom) return;
      // Where the wheel was, in the scrollport's coordinates: this is the point the zoom has to keep
      // still. Recorded here rather than from the last move, because a wheel can arrive with the
      // pointer wherever the reader left it - and it is the wheel that says which point is wanted.
      const rect = viewport.getBoundingClientRect();
      wheelPointRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const geometry = geometryRef.current;
      geometryRef.current = {
        ...geometry,
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
        w: viewport.clientWidth,
        h: viewport.clientHeight,
      };
      onZoomChange(next);
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [zoom, onZoomChange, viewportRef_]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a scrollport is not a control; these handlers are the drag, the wheel and the click that ends a drag, none of which an element around it can do for it
    <div
      ref={viewportRef_}
      data-slot="pan-zoom-surface"
      data-dragging={dragging ? "true" : "false"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onDragStart={onDragStart}
      onClickCapture={onClickCapture}
      className={cn(
        // `safe` centring in both axes: plain centring aligns content wider than the scrollport in
        // the middle of its own box, which puts its leading edge outside the scrollable range, so
        // the left of a wide drawing could never be reached.
        "flex min-h-0 w-full flex-1 overflow-auto [align-items:safe_center] [justify-content:safe_center]",
        draggable && (dragging ? "cursor-grabbing" : "cursor-grab"),
        // Text inside the content is not what a drag is for here.
        dragging && "select-none",
        className,
      )}
    >
      {children}
    </div>
  );
}
