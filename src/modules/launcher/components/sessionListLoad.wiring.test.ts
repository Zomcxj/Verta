import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * How the session list is drawn while it is being read.
 *
 * Opening the panel showed an opencode-only list, which filled in with pi and Claude a moment later.
 * The final order was never tool-priority - `sortByRecent` has always answered newest-first - so the
 * three tools appearing in that order was the list being redrawn once per tool, and `opencode` is
 * asked first and reads one sqlite file.
 *
 * A source's three tools are one block in the list, so the block is drawn when the block is complete.
 * A source is still drawn on its own: a distro is read by running a query inside it and its rows
 * arrive seconds after this machine's, and waiting for it would hold back rows that are answered.
 *
 * Read as text, the way the other wiring tests here do: this repository renders no components.
 */
const panel = readFileSync(
  new URL("./LauncherPanel.tsx", import.meta.url),
  "utf8",
);

describe("the session list while it loads", () => {
  it("redraws a source's block only once all of its tools have answered", () => {
    // The counter is what makes that true: one entry per source, decremented as each tool settles.
    expect(panel).toContain("const unanswered = new Map<string, number>()");
    expect(panel).toContain("if (left === 0) setSessions([...drawCachedRows()])");
  });

  it("does not redraw after every single tool", () => {
    // The old shape: one `setSessions` in the `finally` of each request, so the first tool to answer
    // was drawn alone. A bare call in that position is the bug coming back.
    const perRequestRedraw =
      /setSessions\(\[\.\.\.drawCachedRows\(\)\]\);\s*\n\s*\}\s*,\s*\n\s*\}\)/;
    expect(panel).not.toMatch(perRequestRedraw);
  });

  it("counts the tools of a source, not the sources", () => {
    // Grouped by `distro ?? ""`: the three tools of this machine share one key, so the block waits
    // for all three. Keying on `sourceKeyOf` instead would wait for one tool.
    expect(panel).toContain('const source = request.distro ?? ""');
    expect(panel).toMatch(/unanswered\.set\(source, \(unanswered\.get\(source\) \?\? 0\) \+ 1\)/);
  });
});
