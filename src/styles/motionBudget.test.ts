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
    // A floating layer runs too, and for a sharper reason: several of them enter from `opacity: 0`, so
    // a paused entrance is not a slower layer, it is an empty one - a details card with no words in it
    // and a tooltip that never appears, both readable while the window is in the background.
    expect(css).toMatch(
      /html\[data-window-inactive\] \.verta-float,[^{]*\{[^}]*animation-play-state:\s*running\s*!important/,
    );
    expect(css).toMatch(
      /html\[data-window-inactive\] \.verta-float \*[^{]*\{[^}]*animation-play-state:\s*running\s*!important/,
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
    // A card that arrives by moving must arrive where the row is instead, and its text must not fade
    // in either. The selector is a list, so the match stops at the opening brace rather than
    // requiring the name to be alone.
    expect(reduced).toMatch(
      /\.verta-compact-card[^{]*\{[^}]*animation:\s*none[^}]*transition:\s*none/,
    );
  });

  it("moves the details card rather than remounting it, and keeps it in the motion budget", () => {
    // One card for the list, positioned by transform: following the pointer is that transform
    // changing, so the card's transition is the movement. `data-ready` is what keeps the first
    // placement from animating, and the body fades in when the row changes so the panel is not the
    // thing being replaced. The class appears twice - once here and once under reduced motion, where
    // both are switched off - so the block is found by what it declares.
    const rule = css.match(
      /\.verta-compact-card\s*\{([^}]*opacity:\s*0[^}]*)\}/,
    )?.[1];
    // Hidden until it has been placed, and not transitioning before then: that is what keeps the
    // first appearance from animating in from the window's corner.
    expect(rule).toMatch(/opacity:\s*0/);
    expect(rule).toMatch(/transition:\s*none/);
    const moving = css.match(
      /\.verta-compact-card\[data-ready="true"\]\s*\{([^}]*)\}/,
    )?.[1];
    expect(moving).toMatch(/transform var\(--dur-base\) var\(--ease-soft\)/);
    expect(moving).toMatch(/opacity var\(--dur-fast\) var\(--ease-soft\)/);
    expect(moving).not.toMatch(/filter|backdrop|scale/);
    // Found by what it animates: the same class name appears in the reduced-motion block, where it
    // is switched off.
    const body = css.match(
      /\.verta-compact-card-body\s*\{([^}]*verta-compact-card-body-in[^}]*)\}/,
    )?.[1];
    expect(body).toMatch(/animation:\s*verta-compact-card-body-in/);
    const keyframes = css.match(
      /@keyframes verta-compact-card-body-in\s*\{([^}]*)\}/,
    )?.[1];
    // A fade, not a movement: the card is already travelling.
    expect(keyframes).toMatch(/opacity/);
    expect(keyframes).not.toMatch(/transform|scale/);
  });
});
