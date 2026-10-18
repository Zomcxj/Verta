import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const render = readFileSync(path.join(here, "MarkdownRender.tsx"), "utf8");
const streamdownJsx =
  render.match(/<Streamdown[\s\S]*?<\/Streamdown>/)?.[0] ?? "";

describe("MarkdownRender Streamdown configuration", () => {
  it("renders markdown in static mode, not as a stream", () => {
    expect(streamdownJsx).toMatch(/mode="static"/);
  });

  it("leaves incomplete-markdown repair to the caller", () => {
    // A saved file must not have half-written syntax repaired for it, while a
    // live editor buffer needs exactly that. One shared renderer, so the choice
    // has to be a prop rather than a constant.
    expect(streamdownJsx).toMatch(
      /parseIncompleteMarkdown=\{incomplete \?\? false\}/,
    );
  });
});
