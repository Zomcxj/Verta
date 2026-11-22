import type { Tab } from "@/modules/tabs";
import type { TerminalSearchController } from "@/modules/terminal/search/TerminalSearchController";
import { useEffect, useMemo, useRef } from "react";
import { selectLiveTerminals } from "./lib/liveTerminals";
import { leafIds } from "./lib/panes";
import { PaneTreeView } from "./PaneTreeView";
import type { TerminalPaneHandle } from "./TerminalPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  /**
   * A layer is covering the pane (the session-start transition). The pixels are painted at
   * zero opacity rather than hidden: `visibility` cannot be used from up here, since a pane
   * declares its own (see `TerminalPane`), and hiding it that way also unmounts the
   * renderer's canvas, which leaves the pane blank at the moment the transition lifts
   * instead of showing the session that is already there. Opacity multiplies down the
   * subtree and nothing inside can undo it, so the panes keep rendering while invisible and
   * the reader keeps seeing the pane's own surface (the acrylic, on a glass theme).
   */
  covered?: boolean;
  /**
   * Every leaf whose session is starting, whether or not its tab is the one on screen.
   *
   * Separate from `covered`, and the difference is the bug: `covered` says "the transition layer is
   * up in the tab you are looking at", which is false the moment the reader switches away. The panes
   * it hides are still starting, and their own screens already hold the resume command, so
   * uncovering them on the way out is what made switching tabs and coming back show a bare terminal
   * with the command on it. These leaves keep their pixels hidden until their sessions paint.
   */
  coveredLeaves?: readonly number[];
  /** Register/unregister handle by leaf id (not tab id). */
  registerHandle: (leafId: number, handle: TerminalPaneHandle | null) => void;
  onSearchReady: (leafId: number, addon: TerminalSearchController) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onExit: (leafId: number, code: number) => void;
  onFocusLeaf: (tabId: number, leafId: number) => void;
};

type Bundle = {
  setRef: (h: TerminalPaneHandle | null) => void;
  onSearchReady: (leafId: number, addon: TerminalSearchController) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onExit: (leafId: number, code: number) => void;
};

export function TerminalStack({
  tabs,
  activeId,
  covered = false,
  coveredLeaves = [],
  registerHandle,
  onSearchReady,
  onCwd,
  onExit,
  onFocusLeaf,
}: Props) {
  const terminals = useMemo(() => selectLiveTerminals(tabs), [tabs]);

  const registerRef = useRef(registerHandle);
  const searchReadyRef = useRef(onSearchReady);
  const cwdRef = useRef(onCwd);
  const exitRef = useRef(onExit);
  useEffect(() => {
    registerRef.current = registerHandle;
  }, [registerHandle]);
  useEffect(() => {
    searchReadyRef.current = onSearchReady;
  }, [onSearchReady]);
  useEffect(() => {
    cwdRef.current = onCwd;
  }, [onCwd]);
  useEffect(() => {
    exitRef.current = onExit;
  }, [onExit]);

  const bundles = useRef(new Map<number, Bundle>());
  const getBundle = (leafId: number): Bundle => {
    let b = bundles.current.get(leafId);
    if (!b) {
      b = {
        setRef: (h) => registerRef.current(leafId, h),
        onSearchReady: (id, addon) => searchReadyRef.current(id, addon),
        onCwd: (id, cwd) => cwdRef.current(id, cwd),
        onExit: (id, code) => exitRef.current(id, code),
      };
      bundles.current.set(leafId, b);
    }
    return b;
  };

  useEffect(() => {
    const live = new Set<number>();
    for (const t of terminals)
      for (const id of leafIds(t.paneTree)) live.add(id);
    for (const id of bundles.current.keys()) {
      if (!live.has(id)) bundles.current.delete(id);
    }
  }, [terminals]);

  /**
   * What "the opening transition is covering the pane" does to everything drawn for the
   * terminal.
   *
   * It has to be applied to two siblings that are easy to think of as one: the pane
   * containers, and the area the window's shared render canvas lives in. The renderer
   * draws a pane into a canvas that sits **next to** the containers rather than inside
   * them, so hiding the containers alone leaves the pixels on screen - the command that
   * had just been typed stayed visible under the animation, in every frame of it,
   * however carefully the moment the layer lifts was tuned. Both are hidden here, from
   * one value, so the pair cannot drift apart again.
   */
  const hiddenWhileCovered = covered ? { opacity: 0 } : undefined;

  return (
    <div data-terminal-stack="" className="relative h-full w-full">
      {/*
        The one canvas every WebGPU pane of this window draws into (WebGpuWindowCanvas). It is
        exempt from the app zoom like the panes, so its CSS pixels are real pixels, and it clips
        the canvas to the area. Tabs and panes above it are transparent where it shows through.
      */}
      <div
        data-terminal-area=""
        aria-hidden="true"
        style={hiddenWhileCovered}
        className="zoom-exempt pointer-events-none absolute inset-0 overflow-hidden"
      />
      {terminals.map((t) => {
        const tabVisible = t.id === activeId;
        return (
          <div
            key={t.id}
            data-terminal-tab={t.id}
            className="absolute inset-0"
            style={{
              visibility: tabVisible ? "visible" : "hidden",
              // The transition layer covers the pane: keep painting, show nothing.
              ...hiddenWhileCovered,
              pointerEvents: tabVisible ? "auto" : "none",
            }}
            aria-hidden={!tabVisible}
          >
            <PaneTreeView
              node={t.paneTree}
              tabVisible={tabVisible}
              activeLeafId={t.activeLeafId}
              blocks={t.blocks ?? false}
              coveredLeaves={coveredLeaves}
              onFocusLeaf={(leafId) => onFocusLeaf(t.id, leafId)}
              getBundle={getBundle}
            />
          </div>
        );
      })}
    </div>
  );
}
