import { describe, expect, it } from "vitest";
import { type DiffComment, groupByLine } from "./comments";

function comment(lineNumber: number): DiffComment {
  return {
    id: `c-${lineNumber}`,
    sessionId: "s",
    filePath: "a.rs",
    startLine: null,
    lineNumber,
    body: "x",
    scope: "unstaged",
    sentAt: null,
  };
}

describe("groupByLine", () => {
  it("groups comments by their end line", () => {
    const grouped = groupByLine([comment(10), comment(10), comment(20)]);
    expect(grouped.get(10)).toHaveLength(2);
    expect(grouped.get(20)).toHaveLength(1);
    expect(grouped.get(30)).toBeUndefined();
  });
});
