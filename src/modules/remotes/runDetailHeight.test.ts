import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * How the run detail is sized.
 *
 * Read as text, like the rest of this repository's structural tests: no components are rendered here,
 * and what has to hold is which element owns the scrolling. A log that can run to thousands of lines
 * and is drawn in a box with no height makes its panel grow to fit it, and a panel that grows past the
 * window takes the rest of itself off the bottom of the screen - measured before this: the run detail
 * stood 2000-odd lines tall and could not be closed from where it ended up.
 */
const detail = readFileSync(new URL("./RunDetail.tsx", import.meta.url), "utf8");
const dialog = readFileSync(new URL("./RunListDialog.tsx", import.meta.url), "utf8");

describe("the run detail's height", () => {
  it("is capped by the window rather than by its content", () => {
    expect(detail).toContain("max-h-[calc(min(85vh,720px)-3rem)]");
    expect(dialog).toContain("max-h-[min(85vh,720px)]");
  });

  it("scrolls the log inside itself", () => {
    // The log body takes the height left over and scrolls; a viewport percentage would be a second,
    // unrelated number, and it was what the old box used.
    expect(detail).toContain("min-h-0 flex-1 overflow-auto");
    expect(detail).not.toContain("max-h-[42vh]");
  });

  it("lets the job list scroll on its own instead of pushing the log out", () => {
    expect(detail).toContain("max-h-[28vh] shrink-0 space-y-1.5 overflow-auto");
  });

  it("has a close button, so a tall panel is not a trap", () => {
    // The shared dialog draws it by default; this pins that the run panel does not opt out.
    expect(dialog).not.toContain("showCloseButton={false}");
  });
});
