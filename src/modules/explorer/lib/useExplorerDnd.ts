import type { PointerEvent as ReactPointerEvent } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useT } from "@/modules/i18n";
import { excludeNestedSources } from "./batchMove";

export type ExplorerPathDropTarget = {
  updateTarget: (clientX: number, clientY: number) => boolean;
  dropPath: (paths: string[], clientX: number, clientY: number) => boolean;
  clearTarget: () => void;
};

type Options = {
  rootPath: string;
  isDir: (path: string) => boolean | undefined;
  onMove: (from: string[], toDir: string) => void;
  /** Ctrl (or Cmd) held at drop time: copy instead of move. */
  onCopy: (from: string[], toDir: string) => void;
  getSelectedPaths: () => Set<string>;
  collapseSelectionTo: (path: string) => void;
  pathDropTarget?: ExplorerPathDropTarget;
  /**
   * The pointer left the explorer while a file was held: hand the drag to the operating system.
   *
   * Without it a drag can only end inside the explorer, which is what "文件内的只能文件内拖动移动
   * 不能拖出去" describes - there was no drag session for anything else to receive.
   */
  onDragOut?: (paths: string[]) => void;
};

const THRESHOLD = 5;

function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : path;
}

export function resolveExplorerMoveTarget(
  sources: string[],
  rootPath: string,
  hoveredPath: string | null,
  insideExplorer: boolean,
  isDir: (path: string) => boolean | undefined,
): string | null {
  if (!insideExplorer) return null;
  const target = hoveredPath
    ? isDir(hoveredPath)
      ? hoveredPath
      : parentDir(hoveredPath)
    : rootPath;
  const allAlreadyInTarget = sources.every(
    (source) => parentDir(source) === target,
  );
  if (allAlreadyInTarget) return null;
  for (const source of sources) {
    if (target === source || target.startsWith(`${source}/`)) return null;
  }
  return target;
}

export function finishExplorerDrag(
  commit: boolean,
  sources: string[],
  clientX: number,
  clientY: number,
  moveTarget: string | null,
  pathDropTarget: ExplorerPathDropTarget | undefined,
  onMove: (from: string[], toDir: string) => void,
  onCopy?: (from: string[], toDir: string) => void,
  copy = false,
): void {
  const handledByPathTarget =
    commit && (pathDropTarget?.dropPath(sources, clientX, clientY) ?? false);
  if (commit && !handledByPathTarget && moveTarget) {
    // Ctrl at drop time copies; the default stays a move, as in Explorer.
    if (copy && onCopy) onCopy(sources, moveTarget);
    else onMove(sources, moveTarget);
  }
  pathDropTarget?.clearTarget();
}

// Pointer-based, delegated on the container (no per-row handlers); sidesteps
// native HTML5 DnD which Tauri intercepts when dragDropEnabled is on. The ghost
// follows the cursor via direct DOM writes, so dragging re-renders only when the
// drop target changes, not on every move.
export function useExplorerDnd({
  rootPath,
  isDir,
  onMove,
  onCopy,
  getSelectedPaths,
  collapseSelectionTo,
  pathDropTarget,
  onDragOut,
}: Options) {
  const t = useT();
  // Read through a ref: the pointer handler below wires its listeners once and
  // its dependency list stays empty, so a language switch must not be what
  // rebuilds it.
  const tRef = useRef(t);
  tRef.current = t;
  const [dragLabel, setDragLabel] = useState<string | null>(null);
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null);
  /** Ctrl is held: the ghost says "copy" so the mode is visible before the drop. */
  const [copyMode, setCopyMode] = useState(false);

  const ghostElRef = useRef<HTMLDivElement | null>(null);
  const lastPosRef = useRef({ x: 0, y: 0 });
  const dropTargetRef = useRef<string | null>(null);
  const suppressClickRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  /** The modifier state at drop time; the listeners read it, so it lives in a ref. */
  const copyingRef = useRef(false);
  /** One hand-out per gesture: the pointer keeps moving after the platform owns the drag. */
  const handedOutRef = useRef(false);
  const optsRef = useRef<Options>({
    rootPath,
    isDir,
    onMove,
    onCopy,
    getSelectedPaths,
    collapseSelectionTo,
    pathDropTarget,
    onDragOut,
  });
  // Committed-state snapshot for the pointer listeners below (they attach
  // once and read this ref on every move), so an in-flight drag can't pick up
  // options from a render React later discards.
  useLayoutEffect(() => {
    optsRef.current = {
      rootPath,
      isDir,
      onMove,
      onCopy,
      getSelectedPaths,
      collapseSelectionTo,
      pathDropTarget,
      onDragOut,
    };
  }, [
    rootPath,
    isDir,
    onMove,
    onCopy,
    getSelectedPaths,
    collapseSelectionTo,
    pathDropTarget,
    onDragOut,
  ]);

  const placeGhost = (x: number, y: number) => {
    lastPosRef.current = { x, y };
    const g = ghostElRef.current;
    if (g) {
      g.style.left = `${x + 12}px`;
      g.style.top = `${y + 8}px`;
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: placeGhost only reads refs, and listing it would rebuild the ghost ref callback whenever the drag state ticks
  const ghostRef = useCallback((el: HTMLDivElement | null) => {
    ghostElRef.current = el;
    if (el) placeGhost(lastPosRef.current.x, lastPosRef.current.y);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: placeGhost reads refs only, and listing it would rebuild the pointer handler mid drag
  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-fs-path]");
    const source = el?.getAttribute("data-fs-path");
    if (!source) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let active = false;
    // Decided at drag-activation (not pointerdown), so a plain click that never
    // crosses the threshold never touches selection.
    let sources: string[] = [source];

    const move = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return;
        active = true;
        handedOutRef.current = false;
        lastPosRef.current = { x: ev.clientX, y: ev.clientY };
        const sel = optsRef.current.getSelectedPaths();
        if (sel.has(source) && sel.size > 1) {
          sources = excludeNestedSources([...sel]);
        } else {
          sources = [source];
          optsRef.current.collapseSelectionTo(source);
        }
        setDragLabel(
          sources.length > 1
            ? tRef.current("explorer.dragItems", { count: sources.length })
            : source.slice(source.lastIndexOf("/") + 1),
        );
      }
      placeGhost(ev.clientX, ev.clientY);
      const copying = ev.ctrlKey || ev.metaKey;
      copyingRef.current = copying;
      setCopyMode((was) => (was === copying ? was : copying));
      const { rootPath, isDir, pathDropTarget } = optsRef.current;
      const element = document.elementFromPoint(ev.clientX, ev.clientY);
      const terminalTargeted =
        pathDropTarget?.updateTarget(ev.clientX, ev.clientY) ?? false;
      const insideExplorer = element?.closest("[data-explorer-drop]") != null;
      // Left the explorer with a file held: the platform has to take the drag over. Nothing inside
      // this app can name a destination out there, and a pointer drag has no session for the
      // desktop to receive - which is why a file could never be dragged out before.
      if (!insideExplorer && !terminalTargeted) {
        if (!handedOutRef.current) {
          handedOutRef.current = true;
          // The operating system owns the gesture from here, so this window never sees the release
          // that ends it: drop the pointer drag rather than reporting a move it did not make.
          detach();
          setDragLabel(null);
          setDropTargetDir(null);
          setCopyMode(false);
          dropTargetRef.current = null;
          optsRef.current.onDragOut?.(sources);
        }
        return;
      }
      const hit = element?.closest<HTMLElement>("[data-fs-path]");
      const p = hit?.getAttribute("data-fs-path");
      const valid = terminalTargeted
        ? null
        : resolveExplorerMoveTarget(
            sources,
            rootPath,
            p ?? null,
            insideExplorer,
            isDir,
          );
      if (dropTargetRef.current !== valid) {
        dropTargetRef.current = valid;
        setDropTargetDir(valid);
      }
    };
    const detach = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      cleanupRef.current = null;
    };
    const end = (commit: boolean) => {
      detach();
      if (!active) return;
      const { x, y } = lastPosRef.current;
      const copy = copyingRef.current;
      finishExplorerDrag(
        commit,
        sources,
        x,
        y,
        dropTargetRef.current,
        optsRef.current.pathDropTarget,
        optsRef.current.onMove,
        optsRef.current.onCopy,
        copy,
      );
      suppressClickRef.current = true;
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      dropTargetRef.current = null;
      copyingRef.current = false;
      setDragLabel(null);
      setDropTargetDir(null);
      setCopyMode(false);
    };
    const up = () => end(true);
    const cancel = () => end(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    cleanupRef.current = detach;
  }, []);

  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }, []);

  useEffect(
    () => () => {
      cleanupRef.current?.();
      optsRef.current.pathDropTarget?.clearTarget();
    },
    [],
  );

  return {
    ghostRef,
    dragLabel,
    copyMode,
    dropTargetDir,
    onPointerDown,
    onClickCapture,
  };
}
