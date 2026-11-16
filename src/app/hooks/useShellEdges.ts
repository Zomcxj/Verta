import { useLayoutEffect } from "react";

import { shellEdges } from "../components/shellEdges";

/**
 * Marks which region owns the window's own edge, from the widths the browser actually laid out.
 *
 * Two attempts before this one, both measured on the running app:
 *
 * - the persisted flag the panels write after a resize. The sidebar reached 0px at 330ms and the sheet
 *   stayed square against the window until 939ms - a 600ms square corner, which is the symptom the
 *   corner work exists to remove ("收起时不要贴边，还是要圆角");
 * - the same measurement in React state. That fixed the 600ms and left two frames at 60fps
 *   (`requestAnimationFrame` sampling: `[0,false,0]`, `[0,false,0]`, `[0,true,11]`) - the observer runs
 *   after layout but React commits after that, so the frame in between still paints square.
 *
 * So the attributes are written where the measurement happens. A resize observer callback runs after
 * layout and before paint, and a style change made there lands in the *same* frame - which is what makes
 * this zero frames rather than one. `shellEdges` is unchanged: this only applies its answer.
 *
 * The attributes are deliberately not rendered by React: the element that owns the edge changes without
 * a render, and a render that re-declared them would fight the observer.
 */
export function useShellEdges(row: HTMLElement | null): void {
  // Layout effect, not effect: the first paint of a window that opens with a panel closed must not be
  // square. The observer keeps it true afterwards. The row is a value, not a ref, because zen mode
  // replaces the element: the hook has to attach to the new one, and a node is a dependency that says so.
  useLayoutEffect(() => {
    if (!row) return;
    const regions = {
      sidebar: row.querySelector<HTMLElement>('[data-shell="sidebar"]'),
      workspace: row.querySelector<HTMLElement>('[data-shell="workspace"]'),
      right: row.querySelector<HTMLElement>('[data-shell="right"]'),
    };
    /**
     * The box the row gave each region, which is not the wrapper's.
     *
     * A wrapper carries the seam padding, so a collapsed region still measures those 2-4px and reads as
     * open - and it did: with both side panels closed the observer kept reporting the sidebar as present,
     * so `workspace` never took the window's own edge ("隐藏两个侧边组件 边缘的间距变宽了", the same
     * leftover seam as the 4px the layout kept). The panel's box is the layout's answer and is 0 whatever
     * the wrapper is padded with, so that is what is measured.
     */
    const boxes = {
      sidebar:
        regions.sidebar?.closest<HTMLElement>('[data-slot="resizable-panel"]') ??
        regions.sidebar,
      workspace:
        regions.workspace?.closest<HTMLElement>('[data-slot="resizable-panel"]') ??
        regions.workspace,
      right:
        regions.right?.closest<HTMLElement>('[data-slot="resizable-panel"]') ??
        regions.right,
    };
    const apply = () => {
      const { sidebar, workspace, right } = regions;
      if (!sidebar || !workspace || !right) return;
      // Border-box widths: a collapsed panel is 0, whatever the wrapper around it is padded with.
      const edges = shellEdges({
        sidebar: (boxes.sidebar?.getBoundingClientRect().width ?? 0) > 0.5,
        right: (boxes.right?.getBoundingClientRect().width ?? 0) > 0.5,
      });
      for (const [name, node] of Object.entries(regions)) {
        const edge = edges[name as keyof typeof regions];
        node?.toggleAttribute("data-edge-left", edge.left);
        node?.toggleAttribute("data-edge-right", edge.right);
      }
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    // The panels are observed, not the wrappers: the stylesheet answers these attributes by closing the
    // seam a collapsed region left behind (`globals.css`), which changes the wrapper's own box - and a
    // wrapper that reported that back would put a second callback behind every one of these.
    const observer = new ResizeObserver(apply);
    for (const node of Object.values(boxes)) {
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [row]);
}
