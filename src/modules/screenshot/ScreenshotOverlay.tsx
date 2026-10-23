import { native } from "@/lib/native";
import { useT } from "@/modules/i18n";
import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { listen } from "@tauri-apps/api/event";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  handleCursor,
  isUsableSelection,
  MIN_SIDE,
  moveRect,
  type ResizeHandle,
  rectFromDrag,
  resizeRect,
  type ScreenshotRect,
  toPhysical,
} from "./lib/selection";

type Pt = { x: number; y: number };
type Gesture =
  | { kind: "new"; start: Pt }
  | { kind: "move"; origin: Pt; base: ScreenshotRect }
  | { kind: "resize"; handle: ResizeHandle; origin: Pt; base: ScreenshotRect };

/** Fired when the backend arms the overlay window. The window is kept alive, so
 * every capture starts from this message. */
const ARMED_EVENT = "screenshot:armed";

/**
 * How dark the backdrop is.
 *
 * Keep it light: this layer only signals "capture mode", and the screen below is
 * still live. Dimming too much looks frozen; that is a different approach
 * (frozen snapshot) that users explicitly did not want.
 */
const DIM = "rgba(0, 0, 0, 0.25)";

/** Default for the corner-radius slider (CSS pixels). */
const DEFAULT_RADIUS = 15;

const HANDLES: ResizeHandle[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

/** Handle positions on the box (CSS pixels). Corners sit on the corners, edges on
 * the edge midpoints. */
const HANDLE_POS: Record<
  ResizeHandle,
  { left: string; top: string; translate: string }
> = {
  n: { left: "50%", top: "0%", translate: "translate(-50%, -50%)" },
  ne: { left: "100%", top: "0%", translate: "translate(-50%, -50%)" },
  e: { left: "100%", top: "50%", translate: "translate(-50%, -50%)" },
  se: { left: "100%", top: "100%", translate: "translate(-50%, -50%)" },
  s: { left: "50%", top: "100%", translate: "translate(-50%, -50%)" },
  sw: { left: "0%", top: "100%", translate: "translate(-50%, -50%)" },
  w: { left: "0%", top: "50%", translate: "translate(-50%, -50%)" },
  nw: { left: "0%", top: "0%", translate: "translate(-50%, -50%)" },
};

/**
 * Overlay window: a light gray layer over the whole screen to drag out a region
 * on, adjustable after release.
 *
 * This side only selects and draws. There is no frozen frame to draw on: what
 * sits underneath is the live screen, which stays live during selection (same as
 * the built-in Windows snipping tool). The actual screen grab happens on save,
 * after the backend hides the window, so the dim layer, selection box, handles,
 * and toolbar never end up in the image.
 *
 * Cropping, saving, and copying to the clipboard also live in the backend; all
 * this component does is hand back the selection rect.
 */
export function ScreenshotOverlay() {
  const t = useT();
  /** The region dragged out so far (CSS pixels, relative to the window's top-left).
   * It persists after release until save or cancel. */
  const [rect, setRect] = useState<ScreenshotRect | null>(null);
  const [gesture, setGesture] = useState<Gesture["kind"] | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** Corner radius in CSS pixels; 0 means square. Default 15: a slight rounding
   * reads better in the resulting image. */
  const [radius, setRadius] = useState(DEFAULT_RADIUS);
  const gestureRef = useRef<Gesture | null>(null);

  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const scale = dpr > 0 ? dpr : 1;

  /**
   * The window's own CSS size is the "image" size: it spans the whole virtual
   * desktop, so the selection is measured within whatever size it has, and the
   * backend grabs the same area. Read it live every time: monitors being plugged
   * or unplugged and resolution changes resize the window.
   */
  const viewBounds = useCallback(
    () => ({ width: window.innerWidth, height: window.innerHeight }),
    [],
  );

  /**
   * The window is kept alive (the backend builds the webview once), so every
   * capture begins with this message.
   *
   * On receipt, clear the previous selection, radius, and error; otherwise the
   * old box would still be sitting on screen.
   */
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    void (async () => {
      const off = await listen(ARMED_EVENT, () => {
        setRect(null);
        setFailure(null);
        setSaving(false);
        setRadius(DEFAULT_RADIUS);
        gestureRef.current = null;
        setGesture(null);
      });
      if (disposed) off();
      else stop = off;
    })();
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  const cancel = useCallback(() => {
    void native.screenshotCancel();
  }, []);

  const save = useCallback(async () => {
    if (!rect || saving) return;
    const physical = toPhysical(rect, scale, viewBounds());
    if (!isUsableSelection(physical, scale)) return;
    setSaving(true);
    setFailure(null);
    try {
      // The radius is adjusted in CSS pixels; the backend gets physical pixels.
      const radiusPhysical = Math.round(radius * scale);
      // Neither outcome finishes here: the backend hides the window after grabbing
      // and saving (the grab has to happen after hiding). On failure we get told
      // and the selection stays put, so the user can adjust and save again.
      await native.screenshotFinish(physical, radiusPhysical);
    } catch (e) {
      setFailure(String(e));
      setSaving(false);
    }
  }, [rect, saving, scale, viewBounds, radius]);

  // Esc cancels, Enter saves. Bailing out mid-capture and saving right after
  // dragging are both natural things to reach for.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel, save]);

  // Listen for move / up on window during a gesture: both handles and box body
  // move together, and element-level listeners miss steps because of pointer
  // capture and child elements swallowing events. This is a layout effect so the
  // listeners are attached before the next frame; otherwise the move immediately
  // after pointerdown is lost (fast hands do hit that).
  useLayoutEffect(() => {
    if (!gesture) return;
    const onMove = (event: PointerEvent) => {
      const active = gestureRef.current;
      if (!active) return;
      const at = { x: event.clientX, y: event.clientY };
      if (active.kind === "new") {
        setRect(rectFromDrag(active.start, at));
        return;
      }
      const delta = { dx: at.x - active.origin.x, dy: at.y - active.origin.y };
      const next =
        active.kind === "move"
          ? moveRect(active.base, delta.dx, delta.dy, viewBounds())
          : // Convert the minimum side from physical pixels back to CSS so even the
            // hardest drag cannot make the box unusably small, which would make the
            // handles and toolbar vanish mid-drag.
            resizeRect(
              active.base,
              active.handle,
              delta.dx,
              delta.dy,
              viewBounds(),
              MIN_SIDE / scale,
            );
      setRect(next);
    };
    const onUp = () => {
      const active = gestureRef.current;
      gestureRef.current = null;
      setGesture(null);
      if (active?.kind === "new") {
        // A plain click or a tiny drag: treat it as no selection and let the user
        // start over rather than leaving an unusable box behind.
        setRect((current) => {
          if (!current) return null;
          const physical = toPhysical(current, scale, viewBounds());
          return isUsableSelection(physical, scale) ? current : null;
        });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [gesture, scale, viewBounds]);

  const live = rect ? toPhysical(rect, scale, viewBounds()) : null;
  const hasSelection = !!live && isUsableSelection(live, scale);
  const picking = gesture === "new";
  /** A box exists (even mid-drag): dim outside it with a shadow and keep the inside
   * clear so the user can see what they are capturing. */
  const boxed = !!rect && rect.width > 0 && rect.height > 0;

  const onBackdropPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (saving || event.button !== 0) return;
    const at = { x: event.clientX, y: event.clientY };
    // Pressing inside the box moves it; pressing elsewhere starts a new one.
    if (hasSelection && rect && pointInRect(at, rect)) {
      gestureRef.current = { kind: "move", origin: at, base: rect };
      setGesture("move");
      return;
    }
    gestureRef.current = { kind: "new", start: at };
    setGesture("new");
    setRect({ x: at.x, y: at.y, width: 0, height: 0 });
  };

  const onHandlePointerDown =
    (handle: ResizeHandle) => (event: React.PointerEvent) => {
      if (saving || !rect || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      gestureRef.current = {
        kind: "resize",
        handle,
        origin: { x: event.clientX, y: event.clientY },
        base: rect,
      };
      setGesture("resize");
    };

  /** Where the toolbar sits: at the **bottom-right** corner of the selection, flipped
   * above it when there is no room below, and clamped horizontally to the screen.
   *
   * The width is only used as an estimate for clamping; the bar itself stays
   * content-width (it used to be hard-coded to 188 to fit the size text, which
   * became dead space on the right once the size moved into its own tag).
   */
  const toolbarStyle = (() => {
    if (!rect || !hasSelection) return undefined;
    const estimated = 158;
    const gap = 10;
    const left = Math.max(
      4,
      Math.min(
        rect.x + rect.width - estimated,
        window.innerWidth - estimated - 4,
      ),
    );
    const below = rect.y + rect.height + gap;
    const above = rect.y - gap - 32;
    const top =
      below + 32 <= window.innerHeight - 4 ? below : Math.max(4, above);
    return { left, top };
  })();

  /** The size tag sits above the box by default and flips below when the box is at
   * the top of the screen. */
  const tagAbove = !rect ? true : rect.y >= 34;

  return (
    <div className="fixed inset-0 select-none overflow-hidden">
      {/* Before anything is dragged out, dim the whole screen so capture mode is
          obvious at a glance (like the system tool). Once a box exists this layer
          goes away and the selection's shadow dims outside it instead, keeping the
          live screen visible inside. */}
      {boxed ? null : (
        <div className="absolute inset-0" style={{ background: DIM }} />
      )}

      <div
        data-screenshot-ui="backdrop"
        className="absolute inset-0"
        style={{
          touchAction: "none",
          cursor: picking ? "crosshair" : "default",
        }}
        onPointerDown={onBackdropPointerDown}
      />

      {boxed && rect ? (
        <div
          data-screenshot-ui="box"
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.width,
            height: rect.height,
            // Dim the outside with one huge shadow: simpler than four covers around
            // the box, and it cannot leave seams.
            boxShadow: `0 0 0 100vmax ${DIM}`,
            cursor: hasSelection ? "move" : "crosshair",
            // WYSIWYG rounding: the saved image is rounded exactly like this (the
            // backend cuts with the same radius).
            borderRadius: radius,
          }}
          className="absolute outline-2 outline-primary outline-offset-[-1px]"
          onPointerDown={(event) => {
            if (saving || !hasSelection || event.button !== 0) return;
            event.stopPropagation();
            gestureRef.current = {
              kind: "move",
              origin: { x: event.clientX, y: event.clientY },
              base: rect,
            };
            setGesture("move");
          }}
        >
          {/* Handles only once the box is settled; showing them mid-drag fights with
              the drag gesture. */}
          {hasSelection && !picking
            ? HANDLES.map((handle) => (
                <button
                  key={handle}
                  type="button"
                  aria-label={t("screenshot.handle", { handle })}
                  className="absolute h-2.5 w-2.5 rounded-[3px] border border-primary bg-white shadow-[0_1px_2px_rgba(0,0,0,0.5)] transition-transform hover:scale-110"
                  style={{
                    left: HANDLE_POS[handle].left,
                    top: HANDLE_POS[handle].top,
                    transform: HANDLE_POS[handle].translate,
                    cursor: handleCursor(handle),
                  }}
                  onPointerDown={onHandlePointerDown(handle)}
                />
              ))
            : null}
        </div>
      ) : null}

      {rect && hasSelection && live ? (
        <div
          data-screenshot-ui
          className="absolute flex items-center gap-1.5 rounded-lg border border-white/10 bg-neutral-900/95 p-1 shadow-[0_6px_24px_rgba(0,0,0,0.5)]"
          style={toolbarStyle}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <label
            className="flex items-center gap-1.5 pr-0.5 pl-1"
            title={t("screenshot.radius")}
          >
            <input
              type="range"
              min={0}
              max={40}
              value={radius}
              aria-label={t("screenshot.radius")}
              onChange={(event) => setRadius(Number(event.target.value))}
              className="h-1 w-14 accent-primary"
            />
            <span className="w-5 text-[10px] text-white/55 tabular-nums">
              {radius}
            </span>
          </label>
          <button
            type="button"
            title={t("screenshot.save")}
            aria-label={t("screenshot.save")}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground" />
            ) : (
              <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={2} />
            )}
          </button>
          <button
            type="button"
            title={t("screenshot.cancel")}
            aria-label={t("screenshot.cancel")}
            className="flex h-7 w-7 items-center justify-center rounded-md text-white/75 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-60"
            onClick={cancel}
            disabled={saving}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={2} />
          </button>
        </div>
      ) : null}

      {failure ? (
        <div
          data-screenshot-ui
          className="absolute left-1/2 top-3 -translate-x-1/2 rounded-md border border-red-400/40 bg-red-950/90 px-3 py-1.5 text-[12px] text-red-100 shadow-lg"
        >
          {t("screenshot.saveFailed", { error: failure })}
        </div>
      ) : (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-md bg-black/65 px-2.5 py-1 text-[12px] text-white/90">
          {hasSelection ? t("screenshot.hintAdjust") : t("screenshot.hint")}
        </div>
      )}

      {rect && hasSelection && live ? (
        <div
          className="pointer-events-none absolute flex items-center gap-1.5 rounded-md bg-black/75 px-2 py-1 text-[11px] text-white tabular-nums shadow-lg"
          style={{
            left: Math.max(2, Math.min(rect.x, window.innerWidth - 150)),
            top: tagAbove ? rect.y - 28 : rect.y + rect.height + 6,
          }}
        >
          <span>
            {live.width} × {live.height}
          </span>
          <span className="text-white/50">
            {live.x}, {live.y}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function pointInRect(point: Pt, rect: ScreenshotRect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}
