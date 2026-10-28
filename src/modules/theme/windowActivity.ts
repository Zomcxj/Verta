// "Is anyone looking at this window?" - two answers for the whole webview.
//
// A window that is unfocused, hidden, minimized or fully occluded displays
// nothing the user is watching, so work that only exists to animate pixels
// should stop. Consumers:
//   - CSS: `html[data-window-inactive]` pauses every CSS animation
//     (see globals.css), so spinners, shimmer and pulses stop producing frames;
//   - JS: `useWindowInactive()` / `subscribeWindowInactive()` for things CSS
//     cannot pause (animated background images).
//
// Being unseen is a narrower question and has its own answer, because the two
// are not the same thing to anything that reads them: a window that is on screen
// with another window taking the typing is *inactive* (nothing it animates needs
// frames) but it is not *hidden* (someone can still see it, and a session that
// ended while it was like that is not news). `data-window-hidden` is that
// answer, and it is what the tray, the notifications and the "which leaves are
// being looked at" set are told to mean by nothing-the-user-can-see.
//
// Pure derivation + injected sources keep this testable; the native occlusion
// feed is subscribed from the terminal's shared presentation tracker rather than
// listened to again.

export const WINDOW_INACTIVE_ATTR = "data-window-inactive";
export const WINDOW_HIDDEN_ATTR = "data-window-hidden";

type WindowActivityInputs = {
  /** The webview has OS focus. */
  focused: boolean;
  /** `document.visibilityState === "visible"`. */
  documentVisible: boolean;
  /** Native presentation (occlusion / sleep / hidden) says the window can be seen. */
  presentationVisible: boolean;
};

/** Whether the window can be seen at all - the question the tray and the toasts ask. */
type WindowVisibilityInputs = {
  /** `document.visibilityState === "visible"`. */
  documentVisible: boolean;
  /** Native presentation says the window can be seen. */
  presentationVisible: boolean;
};

export function isWindowInactive(inputs: WindowActivityInputs): boolean {
  return !(
    inputs.focused &&
    inputs.documentVisible &&
    inputs.presentationVisible
  );
}

/**
 * Nobody can see this window: the page is hidden, or the native feed reports
 * occlusion, sleep or the window having been sent to the tray.
 *
 * Focus is deliberately not part of it. A window in front of the user that has
 * another window taking their typing is inactive but seen.
 */
export function isWindowHidden(inputs: WindowVisibilityInputs): boolean {
  return !(inputs.documentVisible && inputs.presentationVisible);
}

type Unsubscribe = () => void;

export type WindowActivitySources = {
  root: Pick<Element, "setAttribute" | "removeAttribute">;
  doc: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  >;
  /** Reports OS focus changes. Not called with the initial state. */
  bindFocus: (listener: (focused: boolean) => void) => Unsubscribe;
  /** Shared native presentation feed; omitted where none exists (Settings). */
  subscribePresentation?: (
    listener: (state: { readonly visible: boolean }) => void,
  ) => Unsubscribe;
};

let inactive = false;
let hidden = false;
const listeners = new Set<() => void>();
const hiddenListeners = new Set<() => void>();

export function getWindowInactive(): boolean {
  return inactive;
}

export function subscribeWindowInactive(listener: () => void): Unsubscribe {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Nobody can see the window - see `isWindowHidden`. */
export function getWindowHidden(): boolean {
  return hidden;
}

export function subscribeWindowHidden(listener: () => void): Unsubscribe {
  hiddenListeners.add(listener);
  return () => {
    hiddenListeners.delete(listener);
  };
}

function publish(next: boolean, root: WindowActivitySources["root"]): void {
  if (next === inactive) return;
  inactive = next;
  if (next) root.setAttribute(WINDOW_INACTIVE_ATTR, "");
  else root.removeAttribute(WINDOW_INACTIVE_ATTR);
  for (const listener of [...listeners]) listener();
}

/**
 * The narrower marker, published on its own list: a transition of this one always moves
 * `inactive` too, but not the other way round, so telling the unseen listeners about a
 * focus change would be telling them about something that did not change.
 */
function publishHidden(
  next: boolean,
  root: WindowActivitySources["root"],
): void {
  if (next === hidden) return;
  hidden = next;
  if (next) root.setAttribute(WINDOW_HIDDEN_ATTR, "");
  else root.removeAttribute(WINDOW_HIDDEN_ATTR);
  for (const listener of [...hiddenListeners]) listener();
}

/**
 * Starts tracking and keeps `data-window-inactive` and `data-window-hidden` on
 * `root` in sync.
 *
 * Starts as seen and watched: the window is assumed looked-at until a blur, a
 * hidden document or a native occlusion report says otherwise. Assuming
 * "unfocused" instead would leave every animation paused forever on a platform
 * that never delivers the first focus event.
 */
export function installWindowActivity(
  sources: WindowActivitySources,
): Unsubscribe {
  const { root, doc } = sources;
  let focused = true;
  let presentationVisible = true;

  const sync = () => {
    const documentVisible = doc.visibilityState === "visible";
    publishHidden(isWindowHidden({ documentVisible, presentationVisible }), root);
    publish(isWindowInactive({ focused, documentVisible, presentationVisible }), root);
  };

  const onVisibility = () => sync();
  doc.addEventListener("visibilitychange", onVisibility);
  const unbindFocus = sources.bindFocus((next) => {
    focused = next;
    sync();
  });
  const unsubscribePresentation = sources.subscribePresentation?.((state) => {
    presentationVisible = state.visible;
    sync();
  });
  sync();

  return () => {
    doc.removeEventListener("visibilitychange", onVisibility);
    unbindFocus();
    unsubscribePresentation?.();
    publishHidden(false, root);
    publish(false, root);
  };
}

/** DOM-only focus source: enough for windows without a native feed. */
export function bindDomWindowFocus(
  listener: (focused: boolean) => void,
): Unsubscribe {
  if (typeof window === "undefined") return () => {};
  const onFocus = () => listener(true);
  const onBlur = () => listener(false);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  return () => {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
  };
}
