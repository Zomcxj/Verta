import { describe, expect, it } from "vitest";
import type { DiffComment } from "./comments";
import { formatComments, resolveLeafForSession } from "./send";

function leaf(id: number) {
  return { kind: "leaf", id, cwd: "/" };
}

function comment(over: Partial<DiffComment> = {}): DiffComment {
  return {
    id: "c",
    sessionId: "s",
    filePath: "src/a.rs",
    startLine: null,
    lineNumber: 42,
    body: "少了错误处理",
    scope: "unstaged",
    sentAt: null,
    ...over,
  };
}

describe("resolveLeafForSession", () => {
  it("finds the leaf of the tab opened for that session", () => {
    const tabs = [{ kind: "terminal", sessionId: "s1", paneTree: leaf(7) }];
    expect(resolveLeafForSession(tabs as never, "s1")).toBe(7);
  });

  it("is null when no tab is open for the session", () => {
    expect(resolveLeafForSession([], "s1")).toBeNull();
  });
});

describe("formatComments", () => {
  // These expectations are copied from the Rust tests in
  // `src-tauri/src/modules/diff_comments/format.rs`: the two implementations have to
  // produce the same line, or the agent reads a different prompt depending on the path.
  it("is a single line for a single-line note", () => {
    expect(formatComments([comment()])).toBe(
      "[git diff review] File: src/a.rs | Line: 42 | 少了错误处理",
    );
  });

  it("says Lines for a range", () => {
    expect(
      formatComments([
        comment({ startLine: 42, lineNumber: 45, body: "这里没处理过期" }),
      ]),
    ).toBe(
      "[git diff review] File: src/a.rs | Lines: 42-45 | 这里没处理过期",
    );
  });

  it("flattens newlines", () => {
    const out = formatComments([comment({ body: "第一行\n第二行" })]);
    expect(out).not.toContain("\n");
    expect(out).toContain("第一行 第二行");
  });

  it("escapes separators", () => {
    const out = formatComments([comment({ body: "a | b ;; c" })]);
    expect(out).toContain("a \\| b \\;\\; c");
  });

  it("joins several notes with the marker once", () => {
    const out = formatComments([
      comment({ filePath: "a.rs", lineNumber: 1 }),
      comment({ filePath: "b.rs", lineNumber: 2 }),
    ]);
    expect(out.match(/\[git diff review\]/g)).toHaveLength(1);
    expect(out).toContain(" ;; ");
  });

  it("is empty for no notes", () => {
    expect(formatComments([])).toBe("");
  });
});
