import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

/**
 * 右侧面板（Git）的宽度与收起态。与左栏 `useSidebarPanel` 同一套做法：宽度存像素、
 * 收起态存一个标记，收起时用 `collapse()` 而不是把宽度记成 0，展开时恢复用户最后一次的宽度。
 *
 * 默认**收起**：Git 是「要看的时候拉出来」的面板，不该挤掉刚打开就在看的终端。
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
    // 没存过就是收起：默认值写在这里，不靠调用方补。
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
      panel.resize(`${rightWidthRef.current}px`);
    }
  }, []);

  const toggleRightPanel = useCallback(() => {
    const panel = rightRef.current;
    if (!panel) return;
    if (panel.getSize().asPercentage <= 0) {
      panel.resize(`${rightWidthRef.current}px`);
    } else {
      panel.collapse();
    }
  }, []);

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
    initialRightCollapsed,
    persistRightCollapsed,
    persistRightWidth,
    openRightPanel,
    toggleRightPanel,
  };
}