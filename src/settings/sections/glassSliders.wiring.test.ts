import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The glass sliders write when a gesture ends, not while it runs or when it mounts.
 *
 * Measured on the first build of these controls: a controlled slider that wrote on every change also
 * wrote once as it appeared, and the pane's opacity was 2% - the slider's minimum - with nobody
 * touching it. The numbers are a preference on disk, so a control that writes without being touched
 * is a control that corrupts what it is meant to show.
 *
 * Read as text, the way the other wiring tests here do: this repository renders no components.
 */
const section = readFileSync(
  new URL("./ThemesSection.tsx", import.meta.url),
  "utf8",
);

describe("the glass sliders", () => {
  it("commits to the preference only when the gesture ends", () => {
    expect(section).toMatch(/onValueCommit=\{\(next\) => \{/);
    // The live handler is local state: no store write can come from a mount or a stray change.
    const live = section.match(/onValueChange=\{\(next\) => ([^}]+)\}/)?.[1] ?? "";
    expect(live).toContain("setDraft");
    expect(live).not.toContain("onChange");
  });

  it("follows the store when it changes underneath the thumb", () => {
    // The reset button writes the preset's numbers; without this the thumbs would stay where the
    // drag left them while the layer behind them had already changed.
    expect(section).toMatch(/useEffect\(\(\) => \{\s*setDraft\(value\);\s*\}, \[value\]\);/);
  });

  it("resets to the preset's own numbers, not to a copy of them", () => {
    expect(section).toContain("setGlassPaneOpacity(GLASS_DEFAULT_PARAMS.paneOpacity)");
    expect(section).toContain("setGlassEdge(GLASS_DEFAULT_PARAMS.edge)");
    expect(section).toContain("setGlassSheen(GLASS_DEFAULT_PARAMS.sheen)");
  });
});
