import { describe, expect, it } from "vitest";
import { documentPathChange } from "./documentPathChange";

describe("documentPathChange", () => {
  it("keeps the document when the caller says the file was renamed or moved", () => {
    // The bug this guards: the editor used to treat this as a new document, clear the unsaved flag
    // and the buffer, and take whatever the new name held on disk.
    expect(
      documentPathChange({
        previousPath: "C:/repo/a.txt",
        path: "C:/repo/b.txt",
        renamedFrom: "C:/repo/a.txt",
      }),
    ).toBe("keep");
  });

  it("loads when the path changes without the caller saying it moved", () => {
    expect(
      documentPathChange({
        previousPath: "C:/repo/a.txt",
        path: "C:/repo/b.txt",
        renamedFrom: null,
      }),
    ).toBe("load");
    // A stale note from an earlier rename names neither the old nor the new path: not a move.
    expect(
      documentPathChange({
        previousPath: "C:/repo/b.txt",
        path: "C:/repo/c.txt",
        renamedFrom: "C:/repo/a.txt",
      }),
    ).toBe("load");
  });

  it("loads the first path it is given", () => {
    expect(
      documentPathChange({ previousPath: null, path: "C:/repo/a.txt" }),
    ).toBe("load");
  });

  it("does nothing when a re-render repeats the same path", () => {
    // A rename leaves the note on the tab, so later renders of the same file must be inert.
    expect(
      documentPathChange({
        previousPath: "C:/repo/b.txt",
        path: "C:/repo/b.txt",
        renamedFrom: "C:/repo/a.txt",
      }),
    ).toBe("none");
  });

  it("keeps a second rename of the same document", () => {
    expect(
      documentPathChange({
        previousPath: "C:/repo/b.txt",
        path: "C:/repo/c.txt",
        renamedFrom: "C:/repo/b.txt",
      }),
    ).toBe("keep");
  });
});
