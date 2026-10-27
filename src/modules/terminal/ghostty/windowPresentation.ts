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
  };  document.addEventListener("visibilitychange", sync);
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
    unlisten?.();
  };
}
