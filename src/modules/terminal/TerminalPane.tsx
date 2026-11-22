import { useT } from "@/modules/i18n";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { TerminalSearchController } from "@/modules/terminal/search/TerminalSearchController";
import type { WorkspaceEnv } from "@/modules/workspace";
import { useTheme } from "@/modules/theme";
import {
  forwardRef,
  lazy,
  memo,
  Suspense,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { TerminalBackendKind } from "./backend/contracts";
import { resolvedTerminalBackend } from "./backend/selection";
import {
  useGhosttyTerminalSession,
  ghosttyBlockGeometry,
} from "./ghostty/useGhosttyTerminalSession";
import { isModelLive } from "./ghostty/modelLiveness";
import { ghosttyBlocks } from "./ghostty/ghosttyBlockSessions";

export type TerminalPaneHandle = {
  write: (data: string) => void;
  focus: () => void;
  getBuffer: (maxLines?: number) => string | null;
  getSelection: () => string | null;
};

export type TerminalPaneProps = {
  /** Stable identifier for this leaf (passed back through callbacks). */
  leafId: number;
  /** Tab containing this pane is on screen. */
  visible: boolean;
  /** This leaf is the active pane within its tab and receives auto-focus. */
  focused?: boolean;
  initialCwd?: string;
  /** Which env this leaf runs in: local by default, or the distro when a WSL session is
   * restored. */
  workspace?: WorkspaceEnv;
  /** Which shell this leaf runs; defaults to the terminal set in preferences. */
  shell?: string;
  /** Enable command-block decorations (OSC 133) for this terminal. */
  blocks?: boolean;
  onSearchReady?: (leafId: number, addon: TerminalSearchController) => void;
  onExit?: (leafId: number, code: number) => void;
  onCwd?: (leafId: number, cwd: string) => void;
};

const TerminalAccessibleOutput = lazy(
  () => import("./ghostty/TerminalAccessibleOutput"),
);
const GhosttyBlockOverlay = lazy(() => import("./ghostty/GhosttyBlockOverlay"));

const GhosttyTerminalPane = memo(
  forwardRef<
    TerminalPaneHandle,
    TerminalPaneProps & {
      backend: Extract<TerminalBackendKind, `ghostty-${string}`>;
    }
  >(function GhosttyTerminalPane(
    {
      leafId,
      visible,
      focused = true,
      initialCwd,
      workspace,
      shell,
      blocks = false,
      onSearchReady,
      onExit,
      onCwd,
      backend,
    },
    ref,
  ) {
    const t = useT();
    const screenReader = usePreferencesStore(
      (state) => state.terminalScreenReader,
    );
    const containerRef = useRef<HTMLDivElement>(null);
    const down = useRef<{ x: number; y: number } | null>(null);
    const { resolvedMode, activeTheme, shape } = useTheme();
    const session = useGhosttyTerminalSession({
      leafId,
      backend,
      container: containerRef,
      visible,
      focused,
      initialCwd,
      workspace,
      shell,
      blocks,
      onSearchReady: (search) => onSearchReady?.(leafId, search),
      onExit: (code) => onExit?.(leafId, code),
      onCwd: (cwd) => onCwd?.(leafId, cwd),
    });

    useEffect(() => {
      void resolvedMode;
      void activeTheme;
      // The shape writes `--terminal-background` too: `glass` clears it so the terminal stops painting
      // a solid rectangle over the material the window draws. The terminal reads its colours from
      // those CSS variables, so a shape change has to make it read them again - otherwise the pane
      // keeps whatever it resolved when the theme last changed, which is a black terminal in a
      // translucent window. The read is deferred to the next frame because the shape is applied by
      // the provider's own effect, and a child's effect runs before the parent's in the same commit.
      void shape;
      const id = requestAnimationFrame(() => session.applyTheme());
      return () => cancelAnimationFrame(id);
    }, [resolvedMode, activeTheme, shape, session]);

    useImperativeHandle(
      ref,
      () => ({
        write: session.write,
        focus: session.focus,
        getBuffer: session.getBuffer,
        getSelection: session.getSelection,
      }),
      [session],
    );

    return (
      <div
        className="zoom-exempt relative h-full w-full overflow-hidden"
        style={{
          visibility: visible ? "visible" : "hidden",
          pointerEvents: visible ? "auto" : "none",
        }}
        onPointerDownCapture={
          blocks
            ? (event) => {
                down.current =
                  event.button === 0 &&
                  event.detail === 1 &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  containerRef.current?.contains(event.target as Node)
                    ? { x: event.clientX, y: event.clientY }
                    : null;
              }
            : undefined
        }
        onPointerUp={
          blocks
            ? (event) => {
                const origin = down.current;
                down.current = null;
                const state = ghosttyBlocks(leafId);
                const geometry = ghosttyBlockGeometry(leafId);
                if (
                  origin &&
                  geometry &&
                  geometry.height > 0 &&
                  Math.hypot(
                    event.clientX - origin.x,
                    event.clientY - origin.y,
                  ) <= 4 &&
                  !state?.model?.trackedSelection?.()
                ) {
                  const row = Math.floor(
                    (event.clientY - geometry.top) / geometry.height,
                  );
                  if (state?.model && row >= 0 && row < state.model.rows)
                    state.controller?.selectAtLine(
                      state.model.bufferLineAtViewportRow(row),
                    );
                }
                if (state?.getMode() === "prompt") state.focus?.();
              }
            : undefined
        }
        data-terminal-backend={backend}
      >
        <div ref={containerRef} className="absolute inset-0" />
        <Suspense fallback={null}>
        </Suspense>
        {screenReader && session.model && isModelLive(session.model) && (
          <Suspense fallback={null}>
            <TerminalAccessibleOutput
              model={session.model}
              visible={visible}
              focused={focused}
              onExit={session.focus}
            />
          </Suspense>
        )}
        {blocks && (
          <Suspense fallback={null}>
            <GhosttyBlockOverlay leafId={leafId} />
          </Suspense>
        )}
        {session.error && (
          <div
            role="alert"
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center text-sm"
          >
            <strong>
              {session.error.kind === "renderer"
                ? t("term.unableToDisplay")
                : t("term.unableToStart")}
            </strong>
            <p className="max-w-md break-words text-muted-foreground">
              {session.error.message}
            </p>
            {session.error.kind === "renderer" && (
              <p className="text-muted-foreground">
                {t("term.sessionPreserved")}
              </p>
            )}
            <button
              type="button"
              className="rounded-md border px-3 py-1.5 hover:bg-accent focus-visible:outline-2"
              onClick={session.retry}
            >
              {session.error.kind === "renderer"
                ? t("term.retryDisplay")
                : t("term.retry")}
            </button>
          </div>
        )}
      </div>
    );
  }),
);

export const TerminalPane = memo(
  forwardRef<TerminalPaneHandle, TerminalPaneProps>(
    function TerminalPane(props, ref) {
      const [backend] = useState(() =>
        usePreferencesStore.getState().terminalRenderer === "webgl"
          ? ("ghostty-webgl" as const)
          : resolvedTerminalBackend(),
      );
      return <GhosttyTerminalPane ref={ref} {...props} backend={backend} />;
    },
  ),
);
