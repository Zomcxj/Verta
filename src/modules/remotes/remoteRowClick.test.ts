import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Which parts of a remote repository row open the runs panel.
 *
 * Read as text, like this repository's other structural tests. The rule is about where a click lands:
 * a whole row that opens the panel makes every column a door to it, and the columns that carry their
 * own controls - visibility, the description, the menu - sit next to a click target that fires whenever
 * one of them misses. One door, on the column that shows the result, is the rule.
 */
const source = readFileSync(new URL("./RemoteReposView.tsx", import.meta.url), "utf8");

describe("a remote repository row", () => {
  it("does not open the runs panel from the row itself", () => {
    // The row keeps its hover check and its pointer cursor is the tell: with no row-level click there
    // is nothing for the cursor to promise.
    const row = source.slice(source.indexOf("<tr\n      className="), source.indexOf("<td className=\"py-1.5 pr-2\">"));
    expect(row).not.toContain("onClick={() => onOpenRuns");
    expect(row).not.toContain("cursor-pointer");
  });

  it("opens it from the CI column, which is where the result is", () => {
    expect(source).toContain("onOpenDetail={() => onOpenRuns(row.fullName)}");
  });

  it("keeps the check on hover, which is not a click", () => {
    expect(source).toContain("onMouseEnter={onHover}");
  });
});
