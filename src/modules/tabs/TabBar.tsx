import { Tabs, TabsList } from "@/components/ui/tabs";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { NewTabMenu, type TerminalChoice } from "./NewTabMenu";
import { type ChipDrag, TabChip, type TabChipDragEvent, TabIcon } from "./TabChip";
import type { Tab } from "./lib/useTabs";

export { TabIcon };

type Props = {
  tabs: Tab[];
  activeId: number;
  onSelect: (id: number) => void;
  onNew: () => void;
  /** Open a specific terminal: a shell on this machine, or one in a distro. */
  onNewTerminal: (choice: TerminalChoice) => void;
  onNewBlock: () => void;
  onNewPrivate: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
  onNewGitGraph: () => void;
  onClose: (id: number) => void;
  /** Chrome-style: close every tab to the right of the given tab. */
  onCloseTabsToRight: (id: number) => void;
  /** Chrome-style: close every tab except the given tab. */
  onCloseOtherTabs: (id: number) => void;
  /** Pin (promote) a preview tab to persistent on double-click. */
  onPin: (id: number) => void;
  /** Set a terminal tab's custom label; empty string resets to default. */
  onRename: (id: number, title: string) => void;
  /** Move a dragged tab to a new position (insertion gap index 0..tabs.length). */
  onReorder: (fromId: number, toGapIndex: number) => void;
  onOverrideLanguage?: (id: number, lang: string | null) => void;
  compact?: boolean;
};

export function TabBar({
  tabs,
  activeId,
  onSelect,
  onNew,
  onNewTerminal,
  onNewBlock,
  onNewPrivate,
  onNewPreview,
  onNewEditor,
  onNewGitGraph,
  onClose,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onPin,
  onRename,
  onReorder,
  onOverrideLanguage,
  compact,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dropGap, setDropGap] = useState<number | null>(null);
  /** `dropGap` as the pointer handlers see it; they are stable and cannot close over state. */
  const dropGapRef = useRef<number | null>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    fromId: number;
    active: boolean;
  } | null>(null);

  // Play the enter animation only for tabs opened after the first paint, never
  // the restored set and never on switch/reorder (triggers are keyed, so they
  // don't remount then). The ref is seeded with the initial ids on first render.
  const seenRef = useRef<Set<number> | null>(null);
  const firstRender = seenRef.current === null;
  let seen = seenRef.current;
  if (seen === null) {
    seen = new Set(tabs.map((t) => t.id));
    seenRef.current = seen;
  }
  useEffect(() => {
    seenRef.current = new Set(tabs.map((t) => t.id));
  }, [tabs]);

  // Single shared pill slides to the active tab instead of each tab toggling
  // its own background. Measured relative to the list (its offsetParent) so it
  // scrolls with the strip for free; transform/width only, no layout on siblings.
  const [pill, setPill] = useState<{ left: number; width: number } | null>(
    null,
  );
  const [pillReady, setPillReady] = useState(false);

  const measurePill = useCallback(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      '[data-tab-active="true"]',
    );
    setPill(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: measurePill has an empty dep list, so these two entries are what re-run the measurement when the active tab or list changes
  useLayoutEffect(() => {
    measurePill();
  }, [measurePill, activeId, tabs]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const ro = new ResizeObserver(measurePill);
    ro.observe(list);
    return () => ro.disconnect();
  }, [measurePill]);

  // Hold the transition off until the pill is first placed, so it never slides
  // in from the origin on mount.
  useEffect(() => {
    if (pill && !pillReady) {
      const id = requestAnimationFrame(() => setPillReady(true));
      return () => cancelAnimationFrame(id);
    }
  }, [pill, pillReady]);

  const gapAtX = useCallback((clientX: number) => {
    const els = Array.from(
      scrollRef.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [],
    );
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return els.length;
  }, []);

  /**
   * The pointer plumbing every chip shares, so it is one stable object: a fresh one would re-render
   * every chip, which is exactly what the chip's memo exists to prevent. The handlers read the drag
   * ref and the latest callbacks instead of closing over state, and the surface setters are stable,
   * so nothing here needs a dependency.
   */
  const latest = useRef({ onSelect, onReorder });
  latest.current = { onSelect, onReorder };

  const beginChipDrag = useCallback(
    (tabId: number, event: TabChipDragEvent) => {
      drag.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        fromId: tabId,
        active: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  const moveChipDrag = useCallback(
    (event: TabChipDragEvent) => {
      const st = drag.current;
      if (!st || st.pointerId !== event.pointerId) return;
      if (!st.active) {
        if (Math.abs(event.clientX - st.startX) < 4) return;
        st.active = true;
        setDraggingId(st.fromId);
        document.body.style.userSelect = "none";
      }
      event.preventDefault();
      const gap = gapAtX(event.clientX);
      dropGapRef.current = gap;
      setDropGap(gap);
    },
    [gapAtX],
  );

  const endChipDrag = useCallback(
    (tabId: number, event: TabChipDragEvent) => {
      const st = drag.current;
      if (st?.active && dropGapRef.current !== null) {
        latest.current.onReorder(st.fromId, dropGapRef.current);
      } else if (st && !st.active) {
        latest.current.onSelect(tabId);
      }
      if (st) event.currentTarget.releasePointerCapture?.(st.pointerId);
      drag.current = null;
      dropGapRef.current = null;
      setDraggingId(null);
      setDropGap(null);
      document.body.style.userSelect = "";
    },
    [],
  );

  const chipDrag = useMemo<ChipDrag>(
    () => ({ begin: beginChipDrag, move: moveChipDrag, end: endChipDrag }),
    [beginChipDrag, moveChipDrag, endChipDrag],
  );

  const startRename = useCallback((id: number) => setEditingId(id), []);
  const endRename = useCallback(() => setEditingId(null), []);

  // Horizontal wheel scroll without holding shift.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the active tab visible after selection / open.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>(`[data-tab-id="${activeId}"]`);
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  return (
    <div
      ref={scrollRef}
      data-tauri-drag-region
      className="min-w-0 shrink overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div className="flex w-max items-center gap-0.5">
        <Tabs
          value={String(activeId)}
          onValueChange={(v) => onSelect(Number(v))}
        >
          <TabsList
            ref={listRef}
            className="relative h-7 w-max gap-0.5 bg-transparent p-0"
          >
            <span
              aria-hidden
              className="pointer-events-none absolute left-0 top-1/2 h-7 rounded-md bg-foreground/[0.07] shadow-sm ring-1 ring-inset ring-foreground/[0.05]"
              style={
                pill
                  ? {
                      width: pill.width,
                      transform: `translate(${pill.left}px, -50%)`,
                      transitionProperty: pillReady
                        ? "transform, width"
                        : "none",
                      transitionDuration: "var(--dur-base)",
                      transitionTimingFunction: "var(--ease-premium)",
                    }
                  : { opacity: 0 }
              }
            />
            {tabs.map((t, i) => {
              const srcIndex = tabs.findIndex((x) => x.id === draggingId);
              const showGap = (gap: number) =>
                draggingId !== null &&
                dropGap === gap &&
                gap !== srcIndex &&
                gap !== srcIndex + 1;

              return (
                <TabChip
                  key={t.id}
                  tab={t}
                  active={t.id === activeId}
                  renaming={editingId === t.id}
                  animateIn={!firstRender && !seen.has(t.id)}
                  dragging={draggingId === t.id}
                  gapBefore={showGap(i)}
                  gapAfter={i === tabs.length - 1 && showGap(tabs.length)}
                  closable={tabs.length > 1}
                  hasTabsToRight={i < tabs.length - 1}
                  onlyTab={tabs.length === 1}
                  compact={compact}
                  onClose={onClose}
                  onCloseTabsToRight={onCloseTabsToRight}
                  onCloseOtherTabs={onCloseOtherTabs}
                  onPin={onPin}
                  onRename={onRename}
                  onOverrideLanguage={onOverrideLanguage}
                  onRenameStart={startRename}
                  onRenameEnd={endRename}
                  drag={chipDrag}
                />
              );
            })}
          </TabsList>
        </Tabs>
        <NewTabMenu
          onNew={onNew}
          onNewTerminal={onNewTerminal}
          onNewBlock={onNewBlock}
          onNewPrivate={onNewPrivate}
          onNewPreview={onNewPreview}
          onNewEditor={onNewEditor}
          onNewGitGraph={onNewGitGraph}
        />
      </div>
    </div>
  );
}

