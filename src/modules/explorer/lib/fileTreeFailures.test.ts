import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * What the file tree says when one of its own writes fails.
 *
 * The repository renders no components, so this is read as text - the same way the motion budget test
 * reads a stylesheet. What is being pinned is not the wording but that there *is* something on screen:
 * creating, renaming and deleting each failed with a line in the developer console and nothing else,
 * so a person who typed a name with a slash in it, or tried to rename a file an editor had locked, saw
 * the input close and assumed it had worked. A failed write that says nothing is worse than an error.
 */
const source = readFileSync(new URL("./useFileTree.ts", import.meta.url), "utf8");

/** The body of one `try { … } catch (e) { … }` inside the hook, as written. */
function catchOf(command: string): string {
  const at = source.indexOf(`"${command}"`);
  expect(at).toBeGreaterThan(-1);
  const after = source.slice(at);
  const catchAt = after.indexOf("catch (e)");
  expect(catchAt).toBeGreaterThan(-1);
  return after.slice(catchAt, catchAt + 600);
}

describe("a file-tree write that fails", () => {
  it("tells the person creating a file or a folder failed", () => {
    // One catch serves both commands; the message names which one from the command it ran.
    const caught = catchOf("fs_create_file");
    expect(caught).toContain("reportWriteFailure(");
    expect(caught).toContain("t(");
  });

  it("tells the person a rename failed", () => {
    const caught = catchOf("fs_rename");
    expect(caught).toContain("reportWriteFailure(");
    expect(caught).toContain("t(");
  });

  it("tells the person a delete failed", () => {
    const caught = catchOf("fs_delete");
    expect(caught).toContain("reportWriteFailure(");
    expect(caught).toContain("t(");
  });

  it("keeps the reason rather than swallowing it", () => {
    // The console line stays: it is what a bug report can quote, and the toast carries the
    // human-readable half. One without the other is a choice this file should not make silently.
    for (const command of ["fs_create_file", "fs_rename", "fs_delete"]) {
      expect(catchOf(command)).toContain("console.error");
    }
  });
});
