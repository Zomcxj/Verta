import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Locks the animation-cost invariants documented in VERTA.md: nothing in the
// global stylesheet animates forever at display rate, and an inactive window
// pauses every CSS animation.
const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

/** Every declaration value that makes an animation repeat forever. */
function infiniteAnimations(source: string): string[] {
  return [
    ...source.matchAll(
      /(--animate-[\w-]+|animation)\s*:\s*([^;]*infinite[^;]*);/g,
    ),
  ].map((m) => `${m[1]}: ${m[2].trim()}`);
}

describe("global motion budget", () => {
  it("only repeats animations forever with stepped timing", () => {
    const infinite = infiniteAnimations(css);
    expect(infinite.length).toBeGreaterThan(0);
    for (const declaration of infinite) {
      expect(declaration, "infinite animation must use steps()").toMatch(
        /steps\(/,
      );
    }
  });

  it("covers the spinner and pulse utilities and the shimmer", () => {
    const names = infiniteAnimations(css).join("\n");
    expect(names).toContain("--animate-spin");
    expect(names).toContain("--animate-pulse");
    expect(names).toContain("verta-shimmer");
    expect(names).toContain("verta-blink");
  });

  it("pauses the animations of an inactive window, except the ones a layer leaves by", () => {
    expect(css).toMatch(
      /html\[data-window-inactive\] \*[^{]*\{[^}]*animation-play-state:\s*paused\s*!important/,
    );
    expect(css).toMatch(/html\[data-window-inactive\] \*::before/);
    expect(css).toMatch(/html\[data-window-inactive\] \*::after/);
    // Radix unmounts a closing layer on `animationend`, so a paused exit animation would leave the
    // closed layer painted over the interface for as long as the window stays in the background.
    expect(css).toMatch(
      /html\[data-window-inactive\] \[data-state="closed"\][^{]*\{[^}]*animation-play-state:\s*running\s*!important/,
    );
  });

  it("keeps a pending approval's pulse finite", () => {
    const rule = css.match(/\.verta-attention-pulse\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/animation:/);
    expect(rule).not.toMatch(/infinite/);
  });

  it("breathes the state dots with stepped timing", () => {
    // The three dots on a session breathe so a state reads from across a window. A forever-running
    // animation is only allowed stepped (above), which is what keeps it a slow breath rather than
    // a smooth fade's worth of frames; and it stops entirely while the window is not being looked
    // at, which is the rule right below.
    const rule = css.match(/\.verta-state-breathe\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/animation:\s*verta-state-breathe[^;]*steps\(/);
    expect(rule).toMatch(/infinite/);
  });

  it("removes the repeating indicators under prefers-reduced-motion", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion"));
    expect(reduced).toMatch(/\.verta-shimmer\s*\{[^}]*animation:\s*none/);
    expect(reduced).toMatch(/\.verta-blink[^{]*\{[^}]*animation:\s*none/);
  });
});
