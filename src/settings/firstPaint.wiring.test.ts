import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Both side windows appear with their first paint, not before it.
 *
 * Reported as "启动后用量和设置页面第一次打开会等一会，后面打开就立马打开了". The second half is the
 * window being reused (both are hidden rather than destroyed on close), and the first half was the
 * window showing itself on a fixed timer: `setTimeout(show, 50)` in settings and a bare `reveal()` in
 * usage, both of which run before React has rendered anything. Measured on a cold open here, the
 * settings page was mounted at 688 ms but had no text until 4.5 s, so the reader was looking at an
 * empty window for most of that wait.
 *
 * A double animation frame is the paint itself, so the window is shown with its first card already
 * drawn. The timer stays behind it as a backstop: a webview that never gets a frame must still
 * appear rather than leave the user with nothing.
 *
 * Read as text, the way the other wiring tests here do: this repository renders no components.
 */
const settings = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const usage = readFileSync(new URL("../usage/main.tsx", import.meta.url), "utf8");

/** Everything from the first `requestAnimationFrame` on, which is the reveal path. */
const revealPath = (source: string) => {
  const at = source.indexOf("requestAnimationFrame");
  expect(at, "no animation frame in the reveal path").toBeGreaterThan(-1);
  return source.slice(at);
};

describe("showing a side window", () => {
  it("waits for a paint in the settings window", () => {
    const path = revealPath(settings);
    // Two frames: the first is the callback, the second is after the render has been laid out and
    // painted, which is the moment worth showing.
    expect(path).toMatch(
      /requestAnimationFrame\(\(\) => \{\s*requestAnimationFrame\(showWindow\);/,
    );
    // The old fixed delay is gone: it showed an empty window and was a guess about paint timing.
    expect(settings).not.toContain("setTimeout(showWindow, 50)");
  });

  it("waits for a paint in the usage window", () => {
    const path = revealPath(usage);
    expect(path).toMatch(
      /requestAnimationFrame\(\(\) => \{\s*requestAnimationFrame\(revealOnce\);/,
    );
    // Called straight from the module body, it revealed the window before React had rendered.
    expect(usage).not.toMatch(/^reveal\(\);$/m);
  });

  it("still shows itself if no frame ever arrives", () => {
    // A hidden or throttled webview gets no animation frame, and a window that never shows is worse
    // than one that shows empty.
    expect(revealPath(settings)).toMatch(/setTimeout\(showWindow, 500\)/);
    expect(revealPath(usage)).toMatch(/setTimeout\(revealOnce, 500\)/);
  });

  it("shows once, whichever path gets there first", () => {
    // Both paths call the same function, and the second call must not repeat the work.
    expect(settings).toMatch(/let shown = false;/);
    expect(settings).toMatch(/if \(shown\) return;/);
    expect(usage).toMatch(/let revealed = false;/);
    expect(usage).toMatch(/if \(revealed\) return;/);
  });
});
