import { useEffect, useSyncExternalStore } from "react";
import {
  bindDomWindowFocus,
  getWindowHidden,
  getWindowInactive,
  installWindowActivity,
  subscribeWindowHidden,
  subscribeWindowInactive,
  type WindowActivitySources,
} from "./windowActivity";

type Props = Pick<WindowActivitySources, "bindFocus" | "subscribePresentation">;

/**
 * Mounts the window-activity tracker (sets `data-window-inactive` on <html>).
 * The main window passes the terminal's shared focus + native presentation
 * feeds; Settings has no native feed and uses plain DOM focus.
 */
export function WindowActivityBridge({
  bindFocus = bindDomWindowFocus,
  subscribePresentation,
}: Partial<Props>) {
  useEffect(
    () =>
      installWindowActivity({
        root: document.documentElement,
        doc: document,
        bindFocus,
        subscribePresentation,
      }),
    [bindFocus, subscribePresentation],
  );
  return null;
}

/** True while the window is unfocused, hidden or occluded. */
export function useWindowInactive(): boolean {
  return useSyncExternalStore(
    subscribeWindowInactive,
    getWindowInactive,
    () => false,
  );
}

/**
 * True while nobody can see the window: it is hidden, minimized or fully occluded. Focus is not
 * part of it - a window the user is looking at with another window taking their typing is still
 * seen, and that is the difference between this and `useWindowInactive`.
 */
export function useWindowHidden(): boolean {
  return useSyncExternalStore(
    subscribeWindowHidden,
    getWindowHidden,
    () => false,
  );
}
