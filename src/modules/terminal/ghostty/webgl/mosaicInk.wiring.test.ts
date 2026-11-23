import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The WebGL renderer must draw a cell-exact glyph as asked, not rescue its ink.
 *
 * A picture in a session is a wall of U+2580 cells whose foreground is the upper half and whose
 * background is the lower half (`OPENTUI_IMAGE_PROTOCOL=blocks`). The ink rescue exists for text a
 * program wrote for a page it is not on, and a photograph's neighbouring rows are always below its
 * threshold, so applying it there turns the picture into a black-and-white field. The GPU renderer
 * already skips it for `GLYPH_ENTRY_FLAG_EXACT`; this holds the WebGL side to the same rule.
 *
 * Source-level, because the renderer needs a live WebGL2 context: what has to stay true is which
 * branch the rescue is behind, and which entry the atlas marks as final.
 */
const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("the WebGL ink rescue and a program's own drawing", () => {
  it("marks a procedurally drawn glyph as final, the way the GPU atlas does", () => {
    const atlas = read("./WebGlGlyphAtlas.ts");
    // The entry carries the fact at all: without it the renderer has nothing to ask.
    expect(atlas).toMatch(/readonly exact: boolean;/);
    // A builtin is drawn from the cell geometry, so its coverage is final.
    const builtin = atlas.slice(atlas.indexOf("private rasterizeBuiltin"));
    expect(builtin).toMatch(/exact: true/);
    // A font glyph is not: it keeps the rescue.
    expect(atlas).toMatch(/intrinsicColor,\s*\n\s*exact: false,/);
  });

  it("rescues only a glyph that is not final", () => {
    const renderer = read("./WebGlCellRenderer.ts");
    // The branch, not the call: `readableInk` must never run for a cell-exact glyph.
    expect(renderer).toMatch(/glyph\.exact\s*\?\s*foreground\s*:\s*readableInk\(foreground, background\)/);
    // And the faint dimming is skipped with it, or the picture would be halved instead of drawn.
    expect(renderer).toMatch(/!glyph\.exact\s*\?\s*faintAlpha/);
  });

  it("keeps the rescue for ordinary text", () => {
    const renderer = read("./WebGlCellRenderer.ts");
    // The call is still there: the fix is a guard, not a removal.
    expect(renderer).toMatch(/readableInk\(foreground, background\)/);
  });
});
