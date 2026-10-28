import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getWindowHidden,
  getWindowInactive,
  installWindowActivity,
  isWindowHidden,
  isWindowInactive,
  subscribeWindowHidden,
  subscribeWindowInactive,
  WINDOW_HIDDEN_ATTR,
  WINDOW_INACTIVE_ATTR,
} from "./windowActivity";

function fakeEnv(visibility: "visible" | "hidden" = "visible") {
  const attrs = new Map<string, string>();
  const docListeners = new Map<string, Set<() => void>>();
  const doc = {
    visibilityState: visibility as DocumentVisibilityState,
    addEventListener: (type: string, fn: () => void) => {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type)?.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      docListeners.get(type)?.delete(fn);
    },
  };
  const root = {
    setAttribute: (name: string, value: string) => attrs.set(name, value),
    removeAttribute: (name: string) => attrs.delete(name),
  };
  let focus: ((focused: boolean) => void) | null = null;
  let presentation: ((s: { visible: boolean }) => void) | null = null;
  const unbindFocus = vi.fn(() => {
    focus = null;
  });
  const unsubscribePresentation = vi.fn(() => {
    presentation = null;
  });
  const sources = {
    root,
    doc: doc as unknown as Document,
    bindFocus: (l: (focused: boolean) => void) => {
      focus = l;
      return unbindFocus;
    },
    subscribePresentation: (l: (s: { visible: boolean }) => void) => {
      presentation = l;
      return unsubscribePresentation;
    },
  };
  return {
    attrs,
    sources,
    unbindFocus,
    unsubscribePresentation,
    setFocus: (v: boolean) => focus?.(v),
    setPresentation: (visible: boolean) => presentation?.({ visible }),
    setVisibility: (v: DocumentVisibilityState) => {
      doc.visibilityState = v;
      for (const fn of docListeners.get("visibilitychange") ?? []) fn();
    },
    docListenerCount: () => docListeners.get("visibilitychange")?.size ?? 0,
  };
}

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

describe("isWindowInactive", () => {
  it("is active only when focused, visible and presented", () => {
    const on = {
      focused: true,
      documentVisible: true,
      presentationVisible: true,
    };
    expect(isWindowInactive(on)).toBe(false);
    expect(isWindowInactive({ ...on, focused: false })).toBe(true);
    expect(isWindowInactive({ ...on, documentVisible: false })).toBe(true);
    expect(isWindowInactive({ ...on, presentationVisible: false })).toBe(true);
  });
});

describe("isWindowHidden", () => {
  it("calls a window hidden when nobody can see it, focused or not", () => {
    // Unseen is the page being hidden, the native feed reporting occlusion, sleep or the window
    // having been sent to the tray. Focus is not part of it: a window someone is looking at has to
    // count as seen even while another window is taking their typing.
    expect(
      isWindowHidden({ documentVisible: false, presentationVisible: true }),
    ).toBe(true);
    expect(
      isWindowHidden({ documentVisible: true, presentationVisible: false }),
    ).toBe(true);
    expect(
      isWindowHidden({ documentVisible: true, presentationVisible: true }),
    ).toBe(false);
  });

  it("leaves inactive as it was: unfocused but visible is inactive, not hidden", () => {
    const seen = { documentVisible: true, presentationVisible: true };
    expect(isWindowInactive({ ...seen, focused: false })).toBe(true);
    expect(isWindowHidden(seen)).toBe(false);
  });
});

describe("installWindowActivity", () => {
  it("starts active without an inactive marker", () => {
    const env = fakeEnv();
    dispose = installWindowActivity(env.sources);
    expect(getWindowInactive()).toBe(false);
    expect(env.attrs.has(WINDOW_INACTIVE_ATTR)).toBe(false);
  });

  it("marks <html> inactive on blur and clears it on focus", () => {
    const env = fakeEnv();
    dispose = installWindowActivity(env.sources);
    env.setFocus(false);
    expect(env.attrs.has(WINDOW_INACTIVE_ATTR)).toBe(true);
    expect(getWindowInactive()).toBe(true);
    env.setFocus(true);
    expect(env.attrs.has(WINDOW_INACTIVE_ATTR)).toBe(false);
    expect(getWindowInactive()).toBe(false);
  });

  it("stays inactive until every reason has cleared", () => {
    const env = fakeEnv();
    dispose = installWindowActivity(env.sources);
    env.setFocus(false);
    env.setPresentation(false);
    env.setVisibility("hidden");
    env.setFocus(true);
    expect(getWindowInactive()).toBe(true);
    env.setPresentation(true);
    expect(getWindowInactive()).toBe(true);
    env.setVisibility("visible");
    expect(getWindowInactive()).toBe(false);
  });

  it("treats a window that starts hidden as inactive", () => {
    const env = fakeEnv("hidden");
    dispose = installWindowActivity(env.sources);
    expect(getWindowInactive()).toBe(true);
    env.setVisibility("visible");
    expect(getWindowInactive()).toBe(false);
  });

  it("follows native occlusion from the shared presentation feed", () => {
    const env = fakeEnv();
    dispose = installWindowActivity(env.sources);
    env.setPresentation(false);
    expect(env.attrs.has(WINDOW_INACTIVE_ATTR)).toBe(true);
    env.setPresentation(true);
    expect(env.attrs.has(WINDOW_INACTIVE_ATTR)).toBe(false);
  });

  it("marks being unseen separately from being unfocused", () => {
    const env = fakeEnv();
    dispose = installWindowActivity(env.sources);
    // Unfocused, still on screen: only the pause marker goes up.
    env.setFocus(false);
    expect(env.attrs.has(WINDOW_INACTIVE_ATTR)).toBe(true);
    expect(env.attrs.has(WINDOW_HIDDEN_ATTR)).toBe(false);
    expect(getWindowHidden()).toBe(false);
    // Then the native feed says nobody can see it: both markers.
    env.setPresentation(false);
    expect(env.attrs.has(WINDOW_HIDDEN_ATTR)).toBe(true);
    expect(getWindowHidden()).toBe(true);
    // Seen again, and back to focused: both markers gone.
    env.setPresentation(true);
    expect(env.attrs.has(WINDOW_HIDDEN_ATTR)).toBe(false);
    env.setFocus(true);
    expect(env.attrs.has(WINDOW_INACTIVE_ATTR)).toBe(false);
  });

  it("tells the unseen listeners only about real transitions", () => {
    const env = fakeEnv();
    dispose = installWindowActivity(env.sources);
    const listener = vi.fn();
    const off = subscribeWindowHidden(listener);
    env.setFocus(false);
    env.setPresentation(false);
    env.setVisibility("hidden");
    // One transition into unseen, however many inputs agree.
    expect(listener).toHaveBeenCalledTimes(1);
    env.setPresentation(true);
    env.setVisibility("visible");
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    env.setPresentation(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("notifies subscribers only on real transitions", () => {
    const env = fakeEnv();
    dispose = installWindowActivity(env.sources);
    const listener = vi.fn();
    const off = subscribeWindowInactive(listener);
    env.setFocus(false);
    env.setFocus(false);
    env.setPresentation(false);
    expect(listener).toHaveBeenCalledTimes(1);
    env.setFocus(true);
    env.setPresentation(true);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    env.setFocus(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("works without a native presentation feed", () => {
    const env = fakeEnv();
    const { subscribePresentation: _unused, ...rest } = env.sources;
    dispose = installWindowActivity(rest);
    env.setFocus(false);
    expect(getWindowInactive()).toBe(true);
  });

  it("releases every source and clears the marker on dispose", () => {
    const env = fakeEnv();
    const stop = installWindowActivity(env.sources);
    env.setFocus(false);
    expect(env.attrs.has(WINDOW_INACTIVE_ATTR)).toBe(true);
    stop();
    expect(env.unbindFocus).toHaveBeenCalledTimes(1);
    expect(env.unsubscribePresentation).toHaveBeenCalledTimes(1);
    expect(env.docListenerCount()).toBe(0);
    expect(env.attrs.has(WINDOW_INACTIVE_ATTR)).toBe(false);
    expect(getWindowInactive()).toBe(false);
  });
});
