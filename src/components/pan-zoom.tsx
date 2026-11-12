"use client";

import { cn } from "@/lib/utils";
import { steppedZoom } from "@/modules/editor/lib/diagramZoom";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
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
}: {
  /** The scale in force, so a wheel knows what to step from. */
  zoom: number;
  /** Without this the wheel is left to the pane, which is what a block inside a message wants. */
  onZoomChange?: (zoom: number) => void;
  /** Whether the content is bigger than the scrollport in either axis; it decides the cursor. */
  draggable: boolean;
  className?: string;
  children: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const swallowClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggable) return;
      const viewport = viewportRef.current;
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
    [draggable],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = dragRef.current;
      const viewport = viewportRef.current;
      if (!state || !viewport || state.pointerId !== event.pointerId) return;
      const next = moveDrag(state, event.clientX, event.clientY);
      dragRef.current = next.state;
      viewport.scrollLeft = next.scrollLeft;
      viewport.scrollTop = next.scrollTop;
    },
    [],
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

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !onZoomChange) return;
    // Ctrl/cmd + wheel, the gesture a viewer is expected to have. Attached by hand and marked
    // non-passive: React's own wheel listener is passive, so `preventDefault` there would do nothing
    // and the webview would zoom the whole window instead of the content.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      onZoomChange(zoomedBy(zoom, event.deltaY < 0 ? 1 : -1));
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [zoom, onZoomChange]);

  return (
    <div
      ref={viewportRef}
      data-slot="pan-zoom-surface"
      data-dragging={dragging ? "true" : "false"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
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
