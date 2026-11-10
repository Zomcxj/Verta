import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { usePanelSlide } from "./usePanelSlide";

/**
 * Width and collapsed state of the right panel (Git). Same approach as `useSidebarPanel`
 * on the left: width is stored in pixels and collapsed state as a flag, collapsing uses
 * `collapse()` rather than recording a width of 0, and expanding restores the user's
 * last width.
 *
 * **Collapsed by default**: Git is a pull-out-when-needed panel and should not squeeze
 * the terminal the user just opened.
 */
const RIGHT_DEFAULT_WIDTH = 380;
export const RIGHT_MIN_WIDTH = 260;
export const RIGHT_MAX_WIDTH = 720;
const RIGHT_WIDTH_STORAGE_KEY = "verta.rightPanel.width";
const RIGHT_COLLAPSED_STORAGE_KEY = "verta.rightPanel.collapsed";

function shouldPersistRightWidth(
  width: number,
  isUserInteraction: boolean,
): boolean {
  return isUserInteraction && width > 0;
}

function clampRightWidth(width: number): number {
  return Math.min(
    RIGHT_MAX_WIDTH,
    Math.max(RIGHT_MIN_WIDTH, Math.round(width)),
  );
}

function readRightWidth(): number {
  try {
    const stored = window.localStorage.getItem(RIGHT_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : NaN;
    return Number.isFinite(parsed)
      ? clampRightWidth(parsed)
      : RIGHT_DEFAULT_WIDTH;
  } catch {
    return RIGHT_DEFAULT_WIDTH;
  }
}

function readRightCollapsed(): boolean {
  try {
    const stored = window.localStorage.getItem(RIGHT_COLLAPSED_STORAGE_KEY);
    // Nothing stored means collapsed: the default lives here rather than being patched
    // in by callers.
    return stored === null ? true : stored === "1";
  } catch {
    return true;
  }
}

export function useRightPanel() {
  const rightRef = useRef<PanelImperativeHandle | null>(null);
  const rightWidthRef = useRef(readRightWidth());
  const rightWidthWriteTimerRef = useRef(0);
  const [initialRightCollapsed] = useState(readRightCollapsed);
  const collapsedRef = useRef(initialRightCollapsed);
  const [rightCollapsed, setRightCollapsed] = useState(initialRightCollapsed);
  // Whether the width change in flight is being drawn as a slide (`usePanelSlide`).
  const { sliding: rightSliding, slide, endSlide: endRightSlide } =
    usePanelSlide();

  const persistRightCollapsed = useCallback((collapsed: boolean) => {
    if (collapsedRef.current === collapsed) return;
    collapsedRef.current = collapsed;
    setRightCollapsed(collapsed);
    try {
      window.localStorage.setItem(
        RIGHT_COLLAPSED_STORAGE_KEY,
        collapsed ? "1" : "0",
      );
    } catch {
      // storage may fail in private mode
    }
  }, []);

  const openRightPanel = useCallback(() => {
    const panel = rightRef.current;
    if (panel && panel.getSize().asPercentage <= 0) {
      slide(() => panel.resize(`${rightWidthRef.current}px`));
    }
  }, [slide]);

  const toggleRightPanel = useCallback(() => {
    const panel = rightRef.current;
    if (!panel) return;
    slide(() => {
      if (panel.getSize().asPercentage <= 0) {
        panel.resize(`${rightWidthRef.current}px`);
      } else {
        panel.collapse();
      }
    });
  }, [slide]);

  const persistRightWidth = useCallback(
    (next: number, isUserInteraction: boolean) => {
      if (!shouldPersistRightWidth(next, isUserInteraction)) return;
      rightWidthRef.current = next;
      if (rightWidthWriteTimerRef.current) {
        window.clearTimeout(rightWidthWriteTimerRef.current);
      }
      rightWidthWriteTimerRef.current = window.setTimeout(() => {
        rightWidthWriteTimerRef.current = 0;
        try {
          window.localStorage.setItem(RIGHT_WIDTH_STORAGE_KEY, String(next));
        } catch {
          // ignore
        }
      }, 200);
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (rightWidthWriteTimerRef.current) {
        window.clearTimeout(rightWidthWriteTimerRef.current);
      }
    };
  }, []);

  return {
    rightRef,
    rightWidthRef,
    rightCollapsed,
    rightSliding,
    endRightSlide,
    initialRightCollapsed,
    persistRightCollapsed,
    persistRightWidth,
    openRightPanel,
    toggleRightPanel,
  };
}