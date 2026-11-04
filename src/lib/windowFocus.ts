import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Bring this window forward, for a drop the OS just delivered to it.
 *
 * A window that is not focused is not painted - and a drag from outside almost always starts in a
 * focused window (Explorer, another app) with this one behind it. Measured 2026-11-04, dragging a
 * file onto a name the folder already held: the native `drag-drop` arrived on time while the window
 * was unfocused, the conflict dialog's DOM was built 42 ms later, and nothing appeared until the
 * window was clicked and came forward. That click is what this is, made at the moment the files land.
 *
 * Only on a drop, never on `enter`/`over`: by then the gesture is finished and the files are landing
 * here, which is when a window is expected to come forward. Focusing mid-drag would take the
 * foreground from the window the drag started in while the user is still holding the button.
 */
export function bringWindowForward(): void {
  void getCurrentWindow()
    .setFocus()
    .catch((error) => console.error("[verta] focus after drop failed:", error));
}
