import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Locks what makes the side panels' slide safe to have at all. The animation lives in the global
// stylesheet because the width is an inline `flex` shorthand `react-resizable-panels` writes, so there
// is nothing in a component to put it on - which means nothing else would notice if it were moved,
// widened to every panel, given a hard-coded duration, or pointed at a property the library never
// changes (which is exactly how the first version shipped, and looked like no animation at all).
const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

/** The rule that animates a panel, with its selector, once whitespace is collapsed. */
function slideRule(source: string): { selector: string; body: string } | null {
  const flat = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  const match = flat.match(/([^{}]*\[data-slot="resizable-panel"\][^{}]*)\{([^}]*)\}/);
  return match ? { selector: match[1].trim(), body: match[2].trim() } : null;
}

describe("the side panels' slide", () => {
  it("only runs while a toggle is in flight", () => {
    const rule = slideRule(css);
    expect(rule, "no rule animates a resizable panel").not.toBeNull();
    // Scoped to the flag the toggle sets. Unscoped, dragging a divider would animate too, and the
    // edge would trail behind the pointer for a quarter of a second on every move.
    expect(rule?.selector).toContain("[data-panel-slide]");
  });

  it("animates the property that actually carries the width", () => {
    const rule = slideRule(css);
    const properties = (rule?.body ?? "")
      .split(";")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(properties).toHaveLength(1);
    // `flex-grow`, not `flex-basis`. Measured against the app: the library sizes a panel with the
    // `flex` shorthand (`flex: 16.07 1 0px`), so the width is a proportion and `flex-basis` stays 0 -
    // a transition on it resolves and animates nothing, which is how the first version of this rule
    // shipped and read as "no animation at all".
    expect(properties[0]).toMatch(/^transition:\s*flex-grow\s/);
    // A composited property here would be a second thing to keep in budget, and the panel is the
    // one element on screen that is always there.
    expect(rule?.body).not.toMatch(/filter|backdrop|translateZ|will-change|opacity/);
  });

  it("takes its duration from the motion tokens, so reduced motion snaps it shut", () => {
    const rule = slideRule(css);
    expect(rule?.body).toMatch(/var\(--dur-[a-z]+\)/);
    // A literal duration would survive `prefers-reduced-motion: reduce`, which only rewrites the
    // tokens - the one place that decision is made.
    expect(rule?.body).not.toMatch(/\b\d+(?:\.\d+)?m?s\b/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,400}--dur-base: 0\.01ms/,
    );
  });
});
