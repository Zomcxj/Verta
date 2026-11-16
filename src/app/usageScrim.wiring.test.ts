import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The mask goes up when the usage window is there, not when the button is pressed.
 *
 * Reported twice as "点击后先出现蒙版再弹窗口" (the mask appears first, the window pops after). The window
 * is its own webview: a first open builds it, boots the page and only then calls `show()`, which is
 * hundreds of milliseconds at best and seconds in dev. Anything that dims the main window on the click
 * itself is therefore up while there is still nothing on top of it - which is exactly what the mask is
 * supposed to say is not the case.
 *
 * The window says when it is up (`src/usage/main.tsx`: show, then emit), and that single statement is
 * what this file keeps single. The scrim is mounted from the event with no fade (`instant`), because an
 * animation's first frame is never ticked for a window that just lost the foreground - that is why
 * waiting for the event paints at all, and why the earlier "raise it on the click" workaround is not
 * needed any more.
 *
 * Read as text, the way the other wiring tests here do: this repository renders no components.
 */
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const usage = readFileSync(new URL("../usage/main.tsx", import.meta.url), "utf8");

/** The body of one declaration, from its `useCallback(` to the closing `}, [])`. */
const callbackBody = (source: string, name: string) => {
  const start = source.indexOf(`const ${name} = useCallback(`);
  expect(start, `${name} is gone`).toBeGreaterThan(-1);
  const end = source.indexOf("}, []);", start);
  expect(end, `${name}'s body cannot be read`).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe("dimming behind the usage window", () => {
  it("does not dim the click that asks for the window", () => {
    // The window is not up yet at this point: dimming here is the reported bug, whatever the window
    // ends up doing.
    expect(callbackBody(app, "openUsageFromHeader")).not.toContain(
      "setUsageWindowOpen",
    );
  });

  it("takes the window's own word for it, in both directions", () => {
    // One statement of truth: the window emits `true` once it has shown itself, and the window's
    // close hides it and emits `false`.
    expect(app).toContain('listen<boolean>("verta:usage-window"');
    expect(app).toContain("setUsageWindowOpen(event.payload === true)");
  });

  it("raises the mask only after the window has shown itself", () => {
    const show = usage.indexOf(".show()");
    const emit = usage.indexOf('emitTo("main", "verta:usage-window"');
    expect(show, "the usage window never shows itself").toBeGreaterThan(-1);
    expect(emit, "the usage window never raises the mask").toBeGreaterThan(-1);
    expect(show).toBeLessThan(emit);
    // Inside the `then`, not beside it: a `show` that failed must leave the window behind it undimmed.
    expect(usage).toContain(".then(() => emitTo(\"main\", \"verta:usage-window\", true))");
  });

  it("is mounted with no fade, so it paints in a window that has lost the focus", () => {
    // The reason the post-focus raise is visible at all. A fading layer stays at its first frame while
    // the compositor is not ticking for this window, and only appears when the window is clicked.
    expect(app).toContain("<FloatingScrim open={usageWindowOpen} instant />");
  });
});
