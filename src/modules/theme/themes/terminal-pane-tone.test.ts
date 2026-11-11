import { describe, expect, it } from "vitest";
import { listBuiltinThemes } from "./index";

/**
 * The terminal paints its own canvas inside the workspace, and the pane behind it paints
 * `--background`. When the two differ the workspace shows a rectangle of the other tone - which is
 * plainest in the shapes that merge or border nothing, and invisible in the shapes whose panes are
 * translucent (there the terminal is transparent and there is no second tone to see).
 */
describe("terminal tone against the pane tone", () => {
  it("gives the terminal the panes' own colour, or none at all", () => {
    const mismatches: string[] = [];
    for (const theme of listBuiltinThemes()) {
      for (const [mode, variant] of Object.entries(theme.variants)) {
        const pane = variant.colors?.background;
        const terminal = variant.terminal?.background;
        if (!pane || !terminal) continue;
        // `transparent` and any colour with alpha are the glass case: the pane shows through.
        if (terminal === "transparent" || /rgba\([^)]*,\s*0?\.\d+\s*\)/.test(terminal)) continue;
        if (terminal.toLowerCase() !== pane.toLowerCase()) {
          mismatches.push(`${theme.id} ${mode}: pane ${pane} vs terminal ${terminal}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
