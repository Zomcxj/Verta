import { describe, expect, it } from "vitest";
import {
  allInPaneSelected,
  filesInPane,
  paneAction,
  selectedInPane,
  togglePaneSelection,
} from "./panes";
import type { SourceControlFileEntry } from "./useSourceControlPanel";

function file(
  path: string,
  over: Partial<SourceControlFileEntry> = {},
): SourceControlFileEntry {
  return {
    key: path,
    path,
    originalPath: null,
    statusCode: "M",
    statusLabel: "modified",
    added: 1,
    removed: 1,
    checkState: over.staged ? "checked" : "unchecked",
    staged: false,
    unstaged: true,
    untracked: false,
    ...over,
  };
}

describe("source-control panes", () => {
  const onlyUnstaged = file("a.ts");
  const onlyStaged = file("b.ts", { staged: true, unstaged: false });
  const both = file("c.ts", {
    staged: true,
    unstaged: true,
    checkState: "indeterminate",
  });
  const entries = [onlyUnstaged, onlyStaged, both];

  it("lists the unstaged edits under changes and the staged ones under staged", () => {
    expect(filesInPane(entries, "changes").map((e) => e.path)).toEqual([
      "a.ts",
      "c.ts",
    ]);
    expect(filesInPane(entries, "staged").map((e) => e.path)).toEqual([
      "b.ts",
      "c.ts",
    ]);
  });

  it("shows a file edited on both sides in both panes", () => {
    // It does have changes on each side; hiding it from one pane is what forced the merged list's
    // three-state checkbox.
    for (const pane of ["changes", "staged"] as const) {
      expect(filesInPane(entries, pane).some((e) => e.path === "c.ts")).toBe(true);
    }
  });

  it("keeps only the ticked paths the pane is showing", () => {
    // A selection made in the other pane is not this pane's business, and neither is a path that has
    // just left it (staged, and so no longer a change).
    const selected = new Set(["a.ts", "b.ts", "gone.ts"]);
    expect(selectedInPane(entries, "changes", selected)).toEqual(["a.ts"]);
    expect(selectedInPane(entries, "staged", selected)).toEqual(["b.ts"]);
  });

  it("reads the header checkbox as 'every file here is ticked'", () => {
    const empty = new Set<string>();
    expect(allInPaneSelected(entries, "changes", empty)).toBe(false);
    expect(allInPaneSelected([], "changes", new Set(["a.ts"]))).toBe(false);
    expect(allInPaneSelected(entries, "changes", new Set(["a.ts"]))).toBe(false);
    expect(allInPaneSelected(entries, "changes", new Set(["a.ts", "c.ts"]))).toBe(true);
    // "b.ts" is not in the changes pane, so ticking it must not make that pane look complete.
    expect(allInPaneSelected(entries, "changes", new Set(["a.ts", "c.ts", "b.ts"]))).toBe(
      true,
    );
    expect(allInPaneSelected(entries, "staged", new Set(["a.ts", "c.ts"]))).toBe(false);
    expect(allInPaneSelected(entries, "staged", new Set(["b.ts", "c.ts"]))).toBe(true);
  });

  it("ticks every file in the pane, and untickes them when they all are", () => {
    const none = new Set<string>();
    const all = togglePaneSelection(entries, "changes", none);
    expect([...all].sort()).toEqual(["a.ts", "c.ts"]);
    const cleared = togglePaneSelection(entries, "changes", all);
    expect([...cleared]).toEqual([]);
  });

  it("leaves the other pane's selection alone", () => {
    const selected = new Set(["b.ts"]);
    expect([...togglePaneSelection(entries, "changes", selected)].sort()).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
    // And unticking the changes pane takes only its own paths out.
    const everything = new Set(["a.ts", "b.ts", "c.ts"]);
    expect([...togglePaneSelection(entries, "changes", everything)]).toEqual(["b.ts"]);
  });

  it("stages from changes and unstages from staged", () => {
    expect(paneAction("changes")).toBe("stage");
    expect(paneAction("staged")).toBe("unstage");
  });
});
