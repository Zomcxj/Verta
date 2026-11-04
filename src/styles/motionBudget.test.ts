import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Locks the animation-cost invariants documented in VERTA.md: nothing in the
// global stylesheet animates forever at display rate, and a window that cannot be
// seen pauses every CSS animation. A window that is merely unfocused is a separate
// question: everything still pauses there except the state indicators, which are
// the thing being watched from across the desk.
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
    // Unseen stops the indicators outright rather than pausing them: a paused breath sits on
    // whatever step it reached, which can be the dimmest one - a third opacity, which on a tab chip
    // reads as no dot at all. Measured: with the window unfocused every dot sat at 0.35 and reported
    // `paused`, which is what made stopping them outright the fix.
    expect(css).toMatch(
      /html\[data-window-hidden\] \.verta-state-indicator[^{]*\{[^}]*animation:\s*none\s*!important/,
    );
    // Merely unfocused is not unseen, though: an indicator the user can still glance at keeps
    // moving, which is the whole reason it exists. Everything else in that window stays paused.
    expect(css).toMatch(
      /html\[data-window-inactive\]:not\(\[data-window-hidden\]\) \.verta-state-indicator[^{]*\{[^}]*animation-play-state:\s*running\s*!important/,
    );
    // The running light repeats forever like the breath, so it is stepped too.
    expect(css).toMatch(
      /\.verta-state-marquee[^{]*\{[^}]*animation:\s*verta-marquee[^;]*steps\(/,
    );
    // The light is two elements - a track with the moving part inside it - so the marker has to
    // cover the indicator's descendants as well. Written to match only the track, a stopped
    // indicator still had its sweep moving, and one that was merely unfocused still had it frozen:
    // the two rules were describing the container and the animation was in the child.
    expect(css).toMatch(
      /html\[data-window-hidden\] \.verta-state-indicator[^{]*\*[^{]*\{[^}]*animation:\s*none\s*!important/,
    );
    expect(css).toMatch(
      /html\[data-window-inactive\]:not\(\[data-window-hidden\]\) \.verta-state-indicator[^{]*\*[^{]*\{[^}]*animation-play-state:\s*running\s*!important/,
    );
  });

  it("keeps a pending approval's pulse finite", () => {
    const rule = css.match(/\.verta-attention-pulse\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/animation:/);
    expect(rule).not.toMatch(/infinite/);
  });

  it("breathes the state dots with stepped timing", () => {
    // The dots on a session breathe so a state reads from across a window. A forever-running
    // animation is only allowed stepped (above), which is what keeps it a slow breath rather than
    // a smooth fade's worth of frames; and it stops outright while the window cannot be seen, which
    // is the rule above.
    const rule = css.match(/\.verta-state-breathe\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/animation:\s*verta-state-breathe[^;]*steps\(/);
    expect(rule).toMatch(/infinite/);
  });

  it("removes the repeating indicators under prefers-reduced-motion", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion"));
    expect(reduced).toMatch(/\.verta-shimmer\s*\{[^}]*animation:\s*none/);
    expect(reduced).toMatch(/\.verta-blink[^{]*\{[^}]*animation:\s*none/);
    expect(reduced).toMatch(
      /\.verta-state-marquee[^{]*\{[^}]*animation:\s*none/,
    );
    // A panel that arrives by moving must arrive at its resting place instead, not move slower.
    expect(reduced).toMatch(/\.verta-compact-card\s*\{[^}]*animation:\s*none/);
  });

  it("gives the compact details panel one beat, and a quicker way out", () => {
    // Slide and fade are the same 160ms and the overshoot settles inside that animation, so the
    // panel reads as arriving rather than as two movements in a row. Leaving is shorter, and
    // neither direction animates anything but transform and opacity. The class appears twice -
    // once here and once as `animation: none` under reduced motion - so the block is found by
    // what it animates rather than by being the first mention of the name.
    const rule = css.match(
      /\.verta-compact-card\s*\{([^}]*verta-compact-card-in[^}]*)\}/,
    )?.[1];
    expect(rule).toMatch(/animation:\s*verta-compact-card-in\s*160ms/);
    expect(rule).not.toMatch(/filter|backdrop/);
    const out = css.match(
      /\.verta-compact-card\[data-state="closed"\]\s*\{([^}]*)\}/,
    )?.[1];
    expect(out).toMatch(/verta-compact-card-out\s*120ms/);
  });
});
