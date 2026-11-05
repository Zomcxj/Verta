import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Source-level regression test for the rendered document's scrollbar.
 *
 * The shell hides every native scrollbar (`html * { scrollbar-width: none }`)
 * and hands the affordance back per region. The code editor had its exception
 * and the rendered document did not, so a long document looked exactly like a
 * short one until the reader tried to scroll. Rendering the panes for real
 * needs the whole editor stack; what matters here is that the class is attached
 * to the right element and that the rule behind it still exists - dropping
 * either half silently brings the bug back.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const modulesDir = path.join(here, "..");
const stylesDir = path.join(modulesDir, "..", "styles");
const previewPane = readFileSync(
  path.join(here, "MarkdownPreviewPane.tsx"),
  "utf8",
);
const sidePreview = readFileSync(
  path.join(modulesDir, "editor", "SidePreview.tsx"),
  "utf8",
);
const globals = readFileSync(path.join(stylesDir, "globals.css"), "utf8");

/**
 * The `className` values that mention `className` - the class only works on the
 * element that scrolls, so the same attribute has to carry the overflow too
 * (an arrow-function prop inside the tag makes matching whole opening tags
 * fragile, and the class list is the part that matters).
 */
function classListsWith(source: string, className: string): string[] {
  return [...source.matchAll(/className="([^"]*)"/g)]
    .map(([, value]) => value)
    .filter((value) => new RegExp(`\\b${className}\\b`).test(value));
}

describe("rendered markdown scrollbar", () => {
  it("puts the scroll container of the full-page preview on the scroll class", () => {
    const classes = classListsWith(previewPane, "verta-doc-scroll");
    expect(classes).toHaveLength(1);
    // It has to be the element that actually scrolls, not a wrapper: the class
    // styles `::scrollbar` on itself.
    expect(classes[0]).toMatch(/\boverflow-auto\b/);
  });

  it("puts the side preview's scroll container on the scroll class too", () => {
    const classes = classListsWith(sidePreview, "verta-doc-scroll");
    expect(classes).toHaveLength(1);
    expect(classes[0]).toMatch(/\boverflow-y-auto\b/);
  });

  it("draws the bar as a thin native one, as the code editor does", () => {
    const block = globals.split(".verta-doc-scroll {")[1];
    expect(block).toBeTruthy();
    const body = block.split("}")[0];
    expect(body).toMatch(/scrollbar-width:\s*thin\s*!important/);
    expect(body).toMatch(/scrollbar-color:/);
    expect(globals).toMatch(
      /\.verta-doc-scroll::-webkit-scrollbar\s*\{[^}]*display:\s*block\s*!important/,
    );
  });

  it("reserves the gutter so text does not jump when the document starts to scroll", () => {
    expect(globals).toMatch(
      /\.verta-doc-scroll\s*\{[^}]*scrollbar-gutter:\s*stable/,
    );
  });

  it("keeps the shell's bars hidden by default", () => {
    // The exception is only an exception while the rule it excepts still holds;
    // a global bar would put a chunky one on every panel of the chrome.
    expect(globals).toMatch(/html \*::-webkit-scrollbar\s*\{[^}]*display:\s*none/);
    expect(globals).toMatch(/scrollbar-width:\s*none/);
  });

  it("keeps the side preview's scrubbers clear of the bar", () => {
    // The scrubbers mark the editor's visible range and used to ride the very
    // edge, which is now the bar's own width - 10px in this webview, while they
    // sat 8px in.
    const scrubbers = sidePreview.match(/absolute right-\S+ w-1 bg-foreground\//g);
    expect(scrubbers).not.toBeNull();
    for (const scrubber of scrubbers ?? []) {
      expect(scrubber).toContain("right-2.5");
    }
  });
});
