import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The wiring that a single component's throw cannot take the window down with it.
 *
 * Read as text, the way the motion budget test reads the stylesheet and the tray hook's test reads
 * its hook: this repository renders no components, and what has to hold is that the application is
 * mounted *inside* something that catches. Measured the other way round, on the installed build:
 * with nothing above the tree, one throw out of a passive effect left a window with an empty screen
 * and nothing but the acrylic material showing through.
 */
const main = readFileSync(new URL("../../main.tsx", import.meta.url), "utf8");
const boundary = readFileSync(
  new URL("./AppErrorBoundary.tsx", import.meta.url),
  "utf8",
);

describe("the root of the application", () => {
  it("mounts the application inside an error boundary", () => {
    expect(main).toContain("AppErrorBoundary");
    expect(main.replace(/\s+/g, " ")).toMatch(
      /<AppErrorBoundary> <App \/> <\/AppErrorBoundary>/,
    );
  });

  it("wraps it exactly once", () => {
    // Twice would be one boundary catching for another, which tells nobody anything new.
    expect(main.match(/<AppErrorBoundary>/g)?.length).toBe(1);
    expect(main.match(/<App\s*\/>/g)?.length).toBe(1);
  });

  it("is a boundary that actually catches", () => {
    expect(boundary).toContain("getDerivedStateFromError");
    expect(boundary).toContain("componentDidCatch");
  });

  it("holds on to the error rather than re-throwing it", () => {
    // A boundary that throws again is a boundary that does nothing: React gives up on the second one.
    expect(boundary).not.toMatch(/throw\s+error/);
  });
});