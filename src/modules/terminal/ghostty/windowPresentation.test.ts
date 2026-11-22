import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalResizeInteractionActive } from "@/modules/terminal/lib/terminalResizeInteraction";
import {
  subscribeWindowPresentation,
  terminalWindowPresentation,
} from "@/modules/terminal/ghostty/windowPresentation";

const bridge = vi.hoisted(() => ({ listen: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ listen: bridge.listen }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
const subscriptions: (() => void)[] = [];

afterEach(() => {
  for (const stop of subscriptions.splice(0)) stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function harness() {
  vi.useFakeTimers();
  let documentVisible = true;
  let documentFocused = true;
  // Keyed by event name: the bridge listens for `visibilitychange` and for `focus`, and a single
  // slot would have the second one overwrite the first.
  const on = new Map<string, () => void>();
  let nativeEvent: (event: { payload: unknown }) => void = () => {};
  let initial: (value: unknown) => void = () => {};
  const unlisten = vi.fn();
  bridge.listen.mockImplementation((_name, callback) => {
    nativeEvent = callback;
    return Promise.resolve(unlisten);
  });
  bridge.invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        initial = resolve;
      }),
  );
  const removeEventListener = vi.fn();
  const addEventListener = vi.fn((name: string, callback: () => void) => {
    on.set(name, callback);
  });
  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: {},
    addEventListener,
    removeEventListener,
  });
  vi.stubGlobal("document", {
    get visibilityState() {
      return documentVisible ? "visible" : "hidden";
    },
    hasFocus: () => documentFocused,
    addEventListener,
    removeEventListener,
  });
  return {
    unlisten,
    addEventListener,
    removeEventListener,
    native(value: unknown) {
      nativeEvent({ payload: value });
    },
    initial(value: unknown) {
      initial(value);
    },
    visible(value: boolean) {
      documentVisible = value;
      on.get("visibilitychange")?.();
    },
    /** The window is now in front, which is what the OS reports as a focus change. */
    focus(focused = true) {
      documentFocused = focused;
      on.get("focus")?.();
    },
    subscribe() {
      const listener = vi.fn();
      const stop = subscribeWindowPresentation(listener);
      subscriptions.push(stop);
      return { listener, stop };
    },
  };
}

describe("window presentation bridge", () => {
  it("shares one event subscription and releases it after the last consumer", async () => {
    const h = harness();
    const first = h.subscribe();
    const second = h.subscribe();
    await Promise.resolve();
    expect(bridge.listen).toHaveBeenCalledOnce();
    expect(h.addEventListener).toHaveBeenCalledTimes(2);
    first.stop();
    expect(h.unlisten).not.toHaveBeenCalled();
    h.visible(false);
    second.stop();
    expect(h.unlisten).toHaveBeenCalledOnce();
    expect(h.removeEventListener).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores stale initial queries and malformed native events", async () => {
    const h = harness();
    h.subscribe();
    await Promise.resolve();
    h.native({ revision: 4, occluded: true, sleeping: false });
    h.initial({ revision: 3, occluded: false, sleeping: false });
    await Promise.resolve();
    for (const payload of [
      null,
      {},
      { revision: -1 },
      { revision: 5, occluded: "false", sleeping: false },
    ])
      h.native(payload);
    expect(terminalWindowPresentation()).toEqual({
      visible: false,
      reclaim: false,
    });
    vi.advanceTimersByTime(2_000);
    expect(terminalWindowPresentation()).toEqual({
      visible: false,
      reclaim: true,
    });
    h.native({ revision: 5, occluded: false, sleeping: false });
    expect(terminalWindowPresentation()).toEqual({
      visible: true,
      reclaim: false,
    });
    h.native({ revision: 6, occluded: false, sleeping: true });
    expect(terminalWindowPresentation()).toEqual({
      visible: false,
      reclaim: true,
    });
    h.visible(false);
    h.native({ revision: 7, occluded: false, sleeping: false });
    expect(terminalWindowPresentation().visible).toBe(false);
    h.visible(true);
    expect(terminalWindowPresentation().visible).toBe(true);
  });

  it("takes the focus of a visible page as the window being shown", async () => {
    // Reported as "此次启动的dev终端都没打开显示": the stored state said the window was hidden (a hide
    // whose show nobody reported, which Windows never corrects on its own), and a hidden window's
    // terminals release their GPU resources, so every pane came up with no canvas at all. Focus
    // plus a visible page cannot happen while a window sits in the tray.
    const h = harness();
    const { listener } = h.subscribe();
    await Promise.resolve();
    h.native({ revision: 4, occluded: false, sleeping: false, hidden: true });
    expect(terminalWindowPresentation().visible).toBe(false);

    h.focus();
    expect(terminalWindowPresentation().visible).toBe(true);
    expect(bridge.invoke).toHaveBeenCalledWith("window_set_hidden", {
      hidden: false,
    });
    expect(listener).toHaveBeenLastCalledWith({ visible: true, reclaim: false });
  });

  it("leaves a window alone while it has no focus, tray or not", async () => {
    const h = harness();
    h.subscribe();
    await Promise.resolve();
    h.native({ revision: 4, occluded: false, sleeping: false, hidden: true });
    h.focus(false);
    expect(terminalWindowPresentation().visible).toBe(false);
    expect(bridge.invoke).not.toHaveBeenCalledWith("window_set_hidden", {
      hidden: false,
    });
  });

  it("unsubscribes a native listener that resolves after its consumer closes", async () => {
    const h = harness();
    const subscriber = h.subscribe();
    subscriber.stop();
    await Promise.resolve();
    expect(h.unlisten).toHaveBeenCalledOnce();
    expect(bridge.invoke).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("publishes the native live resize as a resize gesture without touching visibility", async () => {
    const h = harness();
    const { listener } = h.subscribe();
    await Promise.resolve();
    h.native({ revision: 1, occluded: false, sleeping: false });
    expect(terminalResizeInteractionActive()).toBe(false);

    listener.mockClear();
    h.native({
      revision: 2,
      occluded: false,
      sleeping: false,
      liveResize: true,
    });
    expect(terminalResizeInteractionActive()).toBe(true);
    expect(terminalWindowPresentation().visible).toBe(true);
    expect(listener).not.toHaveBeenCalled();

    h.native({
      revision: 3,
      occluded: false,
      sleeping: false,
      liveResize: false,
    });
    expect(terminalResizeInteractionActive()).toBe(false);
  });

  it("ends a native gesture whose end event never arrives when the last consumer leaves", async () => {
    const h = harness();
    const subscriber = h.subscribe();
    await Promise.resolve();
    h.native({
      revision: 1,
      occluded: false,
      sleeping: false,
      liveResize: true,
    });
    expect(terminalResizeInteractionActive()).toBe(true);

    subscriber.stop();

    expect(terminalResizeInteractionActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a malformed live resize flag", async () => {
    const h = harness();
    h.subscribe();
    await Promise.resolve();
    h.native({
      revision: 1,
      occluded: false,
      sleeping: false,
      liveResize: "yes",
    });
    expect(terminalResizeInteractionActive()).toBe(false);
  });

  it("treats a hidden window as one nobody is looking at, and coming back as shown", async () => {
    const h = harness();
    const { listener } = h.subscribe();
    await Promise.resolve();
    h.native({ revision: 1, occluded: false, sleeping: false });
    expect(terminalWindowPresentation().visible).toBe(true);

    listener.mockClear();
    // Hidden to the tray: Windows reports this as nothing else, so it arrives on its own.
    h.native({ revision: 2, occluded: false, sleeping: false, hidden: true });
    expect(terminalWindowPresentation().visible).toBe(false);
    expect(listener).toHaveBeenCalled();

    h.native({ revision: 3, occluded: false, sleeping: false, hidden: false });
    expect(terminalWindowPresentation().visible).toBe(true);
  });

  it("ignores a malformed hidden flag and old payloads without it", async () => {
    const h = harness();
    h.subscribe();
    await Promise.resolve();
    h.native({ revision: 1, occluded: false, sleeping: false });
    expect(terminalWindowPresentation().visible).toBe(true);
    // A payload from a build that did not have the field is a window that is not hidden.
    h.native({ revision: 2, occluded: false, sleeping: false, hidden: "yes" });
    expect(terminalWindowPresentation().visible).toBe(true);
  });
});
