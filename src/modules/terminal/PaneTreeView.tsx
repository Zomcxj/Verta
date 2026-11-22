import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useT } from "@/modules/i18n";
import type { TerminalSearchController } from "@/modules/terminal/search/TerminalSearchController";
import { Fragment, useCallback, useEffect, useRef } from "react";
import { useTerminalDropStore } from "./lib/dropStore";
import { firstLeafSlotId, type PaneNode } from "./lib/panes";
import {
  beginTerminalResizeInteraction,
  endTerminalResizeInteraction,
} from "./lib/terminalResizeInteraction";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";

type LeafBundle = {
  setRef: (h: TerminalPaneHandle | null) => void;
  onSearchReady: (leafId: number, addon: TerminalSearchController) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onExit: (leafId: number, code: number) => void;
};

type Props = {
  node: PaneNode;
  tabVisible: boolean;
  activeLeafId: number;
  blocks: boolean;
  onFocusLeaf: (leafId: number) => void;
  getBundle: (leafId: number) => LeafBundle;
  /**
   * Every leaf whose session is starting, wherever its tab is. Those panes stay hidden until their
   * sessions paint, so switching tabs and coming back cannot show the resume command underneath.
   */
  coveredLeaves?: readonly number[];
};

export function PaneTreeView(props: Props) {
  const { node } = props;
  if (node.kind === "leaf") {
    const { tabVisible, activeLeafId, blocks, onFocusLeaf, getBundle, coveredLeaves } = props;
    const focused = node.id === activeLeafId;
    const b = getBundle(node.id);
    /**
     * Hidden because this pane's session is starting, not because its tab is in the background.
     *
     * The pixels are painted at zero opacity rather than hidden with `visibility`: a pane declares
     * its own visibility, and hiding it that way also unmounts the renderer's canvas, which leaves
     * the pane blank at the moment the transition lifts instead of showing the session already there.
     */
    const covered = (coveredLeaves ?? []).includes(node.id);
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: focus sync wrapper for one pane; the mouse capture and focus handler only mirror DOM focus into activeLeafId
      <div
        onMouseDownCapture={() => {
          if (!focused) onFocusLeaf(node.id);
        }}
        // Catches focus from Tab, programmatic focus, or any path that
        // skips mousedown, which keeps activeLeafId in sync with DOM focus.
        onFocus={() => {
          if (!focused) onFocusLeaf(node.id);
        }}
        data-pane-leaf={node.id}
        className="relative h-full w-full"
      >
        <TerminalPane
          leafId={node.id}
          visible={tabVisible}
          covered={covered}
          focused={focused}
          initialCwd={node.cwd}
          workspace={node.workspace}
          shell={node.shell}
          blocks={blocks}
          ref={b.setRef}
          onSearchReady={b.onSearchReady}
          onCwd={b.onCwd}
          onExit={b.onExit}
        />
        <DropOverlay leafId={node.id} />
      </div>
    );
  }

  return (
    <ResizablePanelGroup
      orientation={node.dir === "row" ? "horizontal" : "vertical"}
    >
      {node.children.map((child, i) => {
        const slotId = firstLeafSlotId(child);
        return (
          <Fragment key={slotId}>
            {i > 0 && <TerminalResizableHandle />}
            <ResizablePanel id={`pane-slot-${slotId}`} minSize="10%">
              <PaneTreeView {...props} node={child} />
            </ResizablePanel>
          </Fragment>
        );
      })}
    </ResizablePanelGroup>
  );
}

const RESIZE_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
]);

function TerminalResizableHandle() {
  const interactionToken = useRef<object>({});
  const removePointerListeners = useRef<(() => void) | null>(null);

  const finish = useCallback(() => {
    removePointerListeners.current?.();
    removePointerListeners.current = null;
    endTerminalResizeInteraction(interactionToken.current);
  }, []);

  const startPointerInteraction = useCallback(() => {
    finish();
    beginTerminalResizeInteraction(interactionToken.current);
    const handlePointerEnd = () => finish();
    window.addEventListener("pointerup", handlePointerEnd, true);
    window.addEventListener("pointercancel", handlePointerEnd, true);
    removePointerListeners.current = () => {
      window.removeEventListener("pointerup", handlePointerEnd, true);
      window.removeEventListener("pointercancel", handlePointerEnd, true);
    };
  }, [finish]);

  useEffect(() => finish, [finish]);

  return (
    <ResizableHandle
      className="bg-border/50 transition-colors duration-[var(--dur-fast)] after:w-3 hover:bg-border"
      onPointerDownCapture={(event) => {
        if (event.button === 0) startPointerInteraction();
      }}
      onKeyDownCapture={(event) => {
        if (RESIZE_KEYS.has(event.key)) {
          beginTerminalResizeInteraction(interactionToken.current);
        }
      }}
      onKeyUpCapture={(event) => {
        if (RESIZE_KEYS.has(event.key)) finish();
      }}
      onBlur={finish}
    />
  );
}

function DropOverlay({ leafId }: { leafId: number }) {
  const t = useT();
  const active = useTerminalDropStore((s) => s.targetLeafId === leafId);
  if (!active) return null;
  return (
    <div className="pointer-events-none absolute inset-2 grid place-items-center rounded-lg border border-primary/45 bg-background/70 text-xs font-medium text-foreground shadow-lg backdrop-blur-sm">
      {t("term.dropFileHere")}
    </div>
  );
}
