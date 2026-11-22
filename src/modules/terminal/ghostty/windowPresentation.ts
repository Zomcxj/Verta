import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { setNativeLiveResize } from "@/modules/terminal/lib/terminalResizeGesture";
import {
  WindowPresentationPolicy,
  type WindowPresentation,
} from "@/modules/terminal/ghostty/WindowPresentationPolicy";

type NativePresentation = {
  revision: number;
  occluded: boolean;
  sleeping: boolean;
  /**
   * The window has been hidden - sent to the tray, or told to hide. Windows reports neither an
   * occlusion change nor a focus change for that, so it is sent explicitly.
   */
  hidden?: boolean;
  /** The user is dragging the window edge (macOS NSWindow live resize); absent elsewhere. */
  liveResize?: boolean;
};
const listeners = new Set<(state: WindowPresentation) => void>();
let policy: WindowPresentationPolicy | null = null;
let native: NativePresentation = {
  revision: -1,
  occluded: false,
  sleeping: false,
  hidden: false,
};
let disconnect: (() => void) | null = null;

export function terminalWindowPresentation(): WindowPresentation {
  const state = policy?.snapshot();
  const visible =
    typeof document === "undefined" || document.visibilityState === "visible";
  if (state && (!state.visible || visible)) return state;
  return { visible, reclaim: false };
}

export function subscribeWindowPresentation(
  listener: (state: WindowPresentation) => void,
): () => void {
  if (!policy) connect();
  listeners.add(listener);
  listener(terminalWindowPresentation());
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    disconnect?.();
    disconnect = null;
    policy?.dispose();
    policy = null;
    native = { revision: -1, occluded: false, sleeping: false };
    setNativeLiveResize(false);
  };
}

export function windowPresentationDiagnostics() {
  return {
    ...terminalWindowPresentation(),
    native,
    transitions: policy?.transitions ?? 0,
    reclamations: policy?.reclamations ?? 0,
  };
}

/**
 * Say that this window just hid or showed itself.
 *
 * The shell tells the app when the close button sends it to the tray, but a window that hides
 * itself (the page's own `hide()`) produces no event of any kind on Windows, so the answer
 * "is anyone looking" would stay wrong until something else moved it.
 */
export function reportWindowHidden(hidden: boolean): void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  if (!policy) connect();
  void invoke("window_set_hidden", { hidden }).catch((error: unknown) => {
    console.warn("[verta] Could not report the window's visibility:", error);
  });
}

function connect(): void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  policy = new WindowPresentationPolicy((state) => {
    for (const listener of listeners) listener(state);
  });
  const sync = () =>
    policy?.update(
      document.visibilityState === "visible" &&
        !native.occluded &&
        !native.hidden,
      native.sleeping,
    );
  /**
   * A window the page can see and that has the focus is not in the tray, whatever the last report
   * said.
   *
   * The hidden flag is written by whoever hid the window, and on Windows nothing says it came back:
   * hiding delivers no focus change, and the tray reports the show only when the tray is what showed
   * it. A window brought back any other way - `show()` from the page, a launcher, the reader
   * alt-tabbing to it - left the flag standing, and a hidden window's terminals are suspended: every
   * pane drawn while it stayed that way came up with no canvas at all (reported as "终端都没打开
   * 显示"). Focus plus a visible page cannot happen while a window is in the tray, so it is the
   * correction, not a guess.
   */
  const reconcileWithFocus = () => {
    if (!native.hidden) return;
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    native = { ...native, hidden: false };
    reportWindowHidden(false);
    sync();
  };
  const accept = (value: NativePresentation) => {
    if (
      disposed ||
      !value ||
      value.revision < 0 ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < native.revision ||
      typeof value.occluded !== "boolean" ||
      typeof value.sleeping !== "boolean" ||
      (value.hidden !== undefined && typeof value.hidden !== "boolean") ||
      (value.liveResize !== undefined && typeof value.liveResize !== "boolean")
    )
      return;
    native = value;
    // Not part of the visibility policy: only renderers sizing their canvases care.
    setNativeLiveResize(value.liveResize === true);
    sync();
  };
  document.addEventListener("visibilitychange", sync);
  // The correction for a hide whose show nobody reported: see `reconcileWithFocus`.
  window.addEventListener("focus", reconcileWithFocus);
  sync();
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    void getCurrentWindow()
      .listen<NativePresentation>("verta:window-presentation", ({ payload }) =>
        accept(payload),
      )
      .then(async (stop) => {
        if (disposed) {
          stop();
          return;
        }
        unlisten = stop;
        accept(await invoke<NativePresentation>("window_presentation_state"));
        // The stored state is whatever the last writer left: a page that comes up with focus is
        // showing a window, so it is read once here as well as on every focus.
        reconcileWithFocus();
      })
      .catch((error: unknown) => {
        if (!disposed)
          console.warn(
            "[verta] Native window presentation tracking unavailable:",
            error,
          );
      });
  }
  disconnect = () => {
    disposed = true;
    document.removeEventListener("visibilitychange", sync);
    window.removeEventListener("focus", reconcileWithFocus);
    unlisten?.();
  };
}
