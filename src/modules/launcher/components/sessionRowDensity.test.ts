import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What a session row draws in each density, as far as text can say it.
 *
 * This repository renders no components, and two of these rules are the kind that only break a person:
 * the native title tooltip must not double up with the app's own popup (compact only), and the density
 * has to come from the stored preference rather than from a constant. The rest - one line against two,
 * and what the popup itself says - is measured on a screen.
 */
const source = readFileSync(new URL("./SessionList.tsx", import.meta.url), "utf8");

describe("a session row's density", () => {
  it("takes the density from the stored preference", () => {
    expect(source).toContain("sessionListDensity");
    expect(source).toContain("data-session-density={density}");
  });

  it("keeps the browser's own tooltip out of the compact row", () => {
    // Two popups on one hover, one of them saying only the title, is worse than one.
    expect(source).toContain(
      'title={density === "standard" ? session.title : undefined}',
    );
  });

  it("draws the numbers line only in the standard row", () => {
    expect(source).toContain('density === "standard" ? (');
  });

  it("shows the popup in compact mode only, from the library's tooltip", () => {
    // The imported name alone proves nothing: the popup has to be in the compact branch, and the
    // numbers line has to be the shared one rather than a second copy of the three labels.
    expect(source).toContain('density === "compact" ? (');
    expect(source).toMatch(/<TooltipContent\b/);
    expect(source).toContain("{statsLine(stats, Date.now(), language)}");
  });

  it("paints the popup in the window's own surface rather than a fixed one", () => {
    // The shared sheet is a one-line pill in the window's two theme colours, which is right for a
    // status label and wrong for three lines of text: in a light theme the row would open a black
    // block. A floating panel of text in this window is `verta-float`, which is also what gives the
    // glass theme its tint.
    const sheet = /<TooltipContent\b[^>]*className="([^"]*)"/.exec(source)?.[1] ?? "";
    expect(sheet).toContain("verta-float");
    expect(sheet).toContain("bg-popover");
    expect(sheet).toContain("text-popover-foreground");
    // What the shared sheet sets is inverted; any of it left here would fight the surface.
    expect(sheet).not.toContain("bg-foreground");
    expect(sheet).not.toContain("text-background");
  });
});
