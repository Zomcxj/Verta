import { useCallback, useRef, useState } from "react";
import { RESIZE_GRIP, draggedWidth, type ColumnWidths } from "./columnResize";

/** What the pointer is doing to a column, and where it started. */
type Drag = {
  column: number;
  startX: number;
  startWidth: number;
  finish: () => void;
};

/**
 * Dragging a column's edge.
 *
 * A table read from a file states its own widths; this lets the reader change one. What changes is
 * the view: nothing is written back, so a width dragged here is gone on reopening, which is what a
 * read-only pane can honestly offer.
 *
 * The listeners are attached in the press itself rather than in an effect keyed on the dragging
 * state: an effect runs after React has re-rendered, and a pointermove that arrives in between - a
 * fast drag, or one a test sends in a single turn - would be dropped and the drag would do nothing.
 */
export function useColumnDrag(
  header: React.RefObject<HTMLElement | null>,
  offsets: readonly number[],
  widths: readonly number[],
  setWidths: (update: (current: ColumnWidths) => ColumnWidths) => void,
): {
  dragging: number | null;
  /** Attach to the element that draws the column headings. */
  onPointerDown: (event: React.PointerEvent) => void;
} {
  const [dragging, setDragging] = useState<number | null>(null);
  const active = useRef<Drag | null>(null);
  const latest = useRef({ offsets, widths });
  latest.current = { offsets, widths };

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      const element = header.current;
      if (!element || event.button !== 0) return;
      const rect = element.getBoundingClientRect();
      // The press is measured in the heading's own space, which is what the offsets are in. The
      // rect is in screen pixels and the offsets are in CSS pixels, and the pane may be drawn at a
      // zoom: without dividing by that scale, a press on a column's edge misses it by the zoom's
      // own margin and no drag ever starts.
      const scale = rect.width > 0 && element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1;
      const toLocal = (clientX: number) => (clientX - rect.left) / scale;
      const x = toLocal(event.clientX) + element.scrollLeft;
      const current = latest.current;
      let column: number | null = null;
      for (let index = 0; index < current.offsets.length; index += 1) {
        const edge = current.offsets[index] + (current.widths[index] ?? 0);
        if (Math.abs(x - edge) <= RESIZE_GRIP) {
          column = index;
          break;
        }
      }
      if (column === null) return;
      event.preventDefault();
      event.stopPropagation();
      // A drag already running is ended before another starts, so two presses cannot both move.
      active.current?.finish();
      const startWidth = current.widths[column] ?? 0;
      const startX = toLocal(event.clientX);

      const move = (moveEvent: PointerEvent) => {
        // The pointer's travel is in screen pixels too, so it is measured the same way: the drag
        // moves the edge by the distance the pointer moved, not by where the pointer now is.
        const width = draggedWidth(startWidth, startX, toLocal(moveEvent.clientX));
        setWidths((previous) => {
          const next = new Map(previous);
          next.set(column, width);
          return next;
        });
      };
      const previousCursor = document.body.style.cursor;
      document.body.style.cursor = "col-resize";
      const finish = () => {
        document.body.style.cursor = previousCursor;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        active.current = null;
        setDragging(null);
      };
      // The cursor stays a resize arrow and the drag keeps following the pointer wherever it goes,
      // including out of the pane: what ends it is the button coming up, not the pointer leaving.
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      active.current = { column, startX, startWidth, finish };
      setDragging(column);
    },
    [header, setWidths],
  );

  return { dragging, onPointerDown };
}
