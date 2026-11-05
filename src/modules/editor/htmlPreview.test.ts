import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Source-level regression test for the HTML render stop, in the same spirit as
 * `PreviewPane.test.ts`: rendering the pane for real needs CodeMirror, the document hook and a
 * working webview, while what has to be pinned is static - an iframe pointed at the file over the
 * asset protocol, carrying the sandbox the browser preview already uses and *not* the one
 * attribute that must never appear.
 *
 * Comments are stripped first: the source explains in a comment why `allow-top-navigation` is
 * intentionally absent, and an assertion must not be satisfied by prose.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(path.join(here, "EditorPane.tsx"), "utf8");
const src = raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

/**
 * The HTML stop's frame, told apart from the PDF stop's frame earlier in the file by the file
 * protocol it points at.
 */
const frameJsx =
  (src.match(/<iframe[\s\S]*?\/>/g) ?? []).find((tag) =>
    tag.includes("htmlPreviewUrl(path)"),
  ) ?? "";
const frameStart = frameJsx === "" ? -1 : src.indexOf(frameJsx);

describe("HTML preview stop", () => {
  it("recognizes .html and .htm as renderable", () => {
    expect(src).toMatch(/fileExt === "html"/);
    expect(src).toMatch(/fileExt === "htm"/);
  });

  it("declares a frame in the source", () => {
    expect(frameStart).toBeGreaterThan(-1);
    expect(frameJsx).toMatch(/<iframe[\s\S]*?\/>/);
  });

  it("points the frame at the file itself over the asset protocol", () => {
    // No parser between the file and what it looks like, and the same protocol the PDF stop and
    // the image preview already use - but the URL is built segment by segment: `convertFileSrc`
    // encodes the whole path as one segment, and a page whose stylesheet is `./style.css` then
    // resolves it to `http://asset.localhost/style.css` and draws unstyled. See
    // `htmlPreviewUrl.test.ts`.
    expect(frameJsx).toMatch(/src=\{htmlPreviewUrl\(path\)\}/);
  });

  it("grants scripts and same-origin but never top navigation", () => {
    expect(frameJsx).toMatch(/sandbox="[^"]*allow-scripts/);
    expect(frameJsx).toMatch(/sandbox="[^"]*allow-same-origin/);
    // With this, a page could navigate the Tauri webview itself and hand `window.__TAURI__` to an
    // origin of its choosing.
    expect(frameJsx).not.toMatch(/allow-top-navigation/);
    expect(frameJsx).toMatch(/referrerPolicy="no-referrer"/);
  });

  it("only draws the frame while the buffer is clean", () => {
    // The frame reads the file from disk, so a dirty buffer would preview stale text.
    expect(src).toMatch(
      /const htmlRendering = isHtml && htmlRendered && !dirty;/,
    );
    // The frame is the true branch of that condition, and the editor is the false one - the frame
    // replaces the source rather than sitting beside it.
    const gate = src.indexOf("{htmlRendering ? (");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(frameStart);
    expect(src.indexOf("<CodeMirror")).toBeGreaterThan(frameStart);
  });

  it("disables the rendered stop while there are unsaved edits", () => {
    expect(src).toMatch(/renderedDisabled=\{dirty\}/);
  });

  it("leaves the caller's own control alone where one is passed in", () => {
    // Markdown hands its three-stop control down through `renderToggle`; a second group in the
    // same corner would overlap it.
    expect(src).toMatch(/isHtml && !renderToggle/);
  });
});
