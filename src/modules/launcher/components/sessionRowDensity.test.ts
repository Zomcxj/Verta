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
    expect(source).toContain("TooltipContent");
    expect(source).toContain("statsLine");
  });
});
