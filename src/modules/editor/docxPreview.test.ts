import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DocxBlock } from "@/lib/native";
import {
  groupBlocks,
  isEditableBlock,
  pendingEdits,
  tableGrid,
} from "./DocxPreview";

const run = (text: string) => ({
  text,
  bold: false,
  italic: false,
  underline: false,
});
let nextIndex = 0;
const paragraph = (
  text: string,
  over: {
    heading?: number | null;
    list?: { ordered: boolean; level: number } | null;
    index?: number;
  } = {},
): DocxBlock => ({
  kind: "paragraph",
  // The ordinal the writer addresses this paragraph by; a document's own order is what it is.
  index: over.index ?? nextIndex++,
  heading: over.heading ?? null,
  list: over.list ?? null,
  runs: [run(text)],
});

describe("docx blocks to groups", () => {
  it("keeps a run of list items in one list", () => {
    // Word marks numbering on each paragraph; the element that makes them read as a list is drawn
    // here, so consecutive items have to end up under one of them.
    const groups = groupBlocks([
      paragraph("first", { list: { ordered: false, level: 0 } }),
      paragraph("nested", { list: { ordered: false, level: 1 } }),
      paragraph("second", { list: { ordered: false, level: 0 } }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "list", ordered: false });
    const items = groups[0].kind === "list" ? groups[0].items : [];
    expect(items.map((item) => item.runs[0].text)).toEqual([
      "first",
      "nested",
      "second",
    ]);
    expect(items.map((item) => item.level)).toEqual([0, 1, 0]);
  });

  it("takes the numbering style from the list's first item", () => {
    const groups = groupBlocks([
      paragraph("1.", { list: { ordered: true, level: 0 } }),
      paragraph("2.", { list: { ordered: true, level: 0 } }),
    ]);
    expect(groups[0]).toMatchObject({ kind: "list", ordered: true });
  });

  it("ends a list at anything that is not a list item", () => {
    const groups = groupBlocks([
      paragraph("item", { list: { ordered: false, level: 0 } }),
      paragraph("a paragraph"),
      paragraph("another item", { list: { ordered: false, level: 0 } }),
    ]);
    expect(groups.map((group) => group.kind)).toEqual([
      "list",
      "block",
      "list",
    ]);
  });

  it("passes headings and tables through untouched", () => {
    const table: DocxBlock = { kind: "table", rows: [["a", "b"]] };
    const title = paragraph("Title", { heading: 2 });
    const groups = groupBlocks([title, table]);
    expect(groups.map((group) => group.kind)).toEqual(["block", "block"]);
    expect(groups[0].kind === "block" && groups[0].block).toEqual(title);
    expect(groups[1].kind === "block" && groups[1].block).toEqual(table);
  });

  it("numbers what it draws so each block has a key of its own", () => {
    // A document's blocks have no identity beyond their position, and two identical paragraphs are
    // normal, so the id is the position - assigned here, once, rather than read off a map callback.
    const groups = groupBlocks([
      paragraph("same"),
      paragraph("same"),
      paragraph("item", { list: { ordered: false, level: 0 } }),
      paragraph("item", { list: { ordered: false, level: 0 } }),
    ]);
    expect(groups.map((group) => group.id)).toEqual([0, 1, 2]);
    const items = groups[2].kind === "list" ? groups[2].items : [];
    expect(items.map((item) => item.id)).toEqual([2, 3]);
  });

  it("numbers a table's rows and cells", () => {
    expect(tableGrid([["a", "b"], ["c"]])).toEqual([
      { id: 0, cells: [{ id: 0, text: "a" }, { id: 1, text: "b" }] },
      { id: 1, cells: [{ id: 0, text: "c" }] },
    ]);
  });
});

/** The routing lives in the editor pane, and what has to hold is static: a `.docx` goes to the
 *  reader, a `.doc` says why it cannot, and the document scrolls with the bar the rest of the
 *  rendered documents have. */
describe("docx routing in the editor pane", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pane = readFileSync(path.join(here, "EditorPane.tsx"), "utf8");
  const preview = readFileSync(path.join(here, "DocxPreview.tsx"), "utf8");

  it("sends .docx to the reader, whatever the text read said about the file", () => {
    // The check sits before the file-read status branches: an archive is not text, so the reader is
    // what decides whether it can be read - not the text sniffer, whose answer for a `.docx` whose
    // bytes happen to be text (or which is empty) is "text" and used to open it in the source editor.
    expect(pane).toMatch(
      /if \(fileExt === "docx"\) return <DocxPreview ref=\{docxRef\} path=\{path\} \/>;/,
    );
    const readerAt = pane.indexOf('if (fileExt === "docx") return');
    const loadingAt = pane.indexOf('if (doc.status === "loading")');
    expect(readerAt).toBeGreaterThan(-1);
    expect(readerAt).toBeLessThan(loadingAt);
  });

  it("never lets the source editor's save write over an archive", () => {
    // Nothing is read as text for a `.docx`, so the pane's buffer is empty - and `Mod+S` on that
    // buffer would empty the file. The document pane saves itself, a paragraph at a time.
    expect(pane).toMatch(
      /if \(fileExt === "docx" \|\| statusRef\.current !== "ready"\)/,
    );
  });

  it("says what the old format needs instead of calling it a binary file", () => {
    expect(pane).toMatch(/ext === "doc"/);
    expect(pane).toMatch(/editor\.docUnsupported/);
  });

  it("scrolls the document with the bar the other rendered documents use", () => {
    expect(preview).toMatch(/className="verta-doc-scroll[^"]*"/);
    expect(preview).toMatch(/overflow-auto/);
  });

  it("cancels a read that lands after the file is gone", () => {
    expect(preview).toMatch(/cancelled = true/);
  });

  it("takes undo from the shell's shortcut, which claims the key before the pane can", () => {
    // `useGlobalShortcuts` matches Mod+Z in the capture phase and calls
    // stopImmediatePropagation, so a keydown listener inside the pane never hears the key at all -
    // an earlier version had one and it was dead code. Undo therefore travels the same way every
    // other editor command does: the shell asks the pane's handle.
    expect(preview).toMatch(/useImperativeHandle\(ref, \(\) => \(\{ undo \}\)/);
    expect(preview).not.toMatch(/key\.toLowerCase\(\) === "z"/);
    expect(pane).toMatch(/docxRef\.current\.undo\(\)/);
    // ... and before the CodeMirror branch, or a document pane would fall through to a view it
    // does not have.
    expect(pane.indexOf("docxRef.current.undo()")).toBeLessThan(
      pane.indexOf("const view = cmRef.current?.view;", pane.indexOf("undo: () => {")),
    );
  });
});

describe("docx editing", () => {
  it("sends a new paragraph after the one it belongs to, in order", () => {
    // Enter splits the paragraph it was pressed in: the text before the caret stays, the text after
    // becomes a paragraph added after it.
    expect(
      pendingEdits(new Map([[1, "before"]]), new Set(), [
        { after: 4, text: "second" },
        { after: 1, text: "after" },
      ]),
    ).toEqual({
      edits: [{ index: 1, text: "before" }],
      deleted: [],
      inserts: [
        { after: 1, text: "after" },
        { after: 4, text: "second" },
      ],
    });
  });

  it("sends the typed paragraphs and the deletions, in document order", () => {
    const texts = new Map([
      [5, "second"],
      [2, "first"],
      [7, "gone"],
    ]);
    const deleted = new Set([7]);
    expect(pendingEdits(texts, deleted, [])).toEqual({
      edits: [
        { index: 2, text: "first" },
        { index: 5, text: "second" },
      ],
      deleted: [7],
      inserts: [],
    });
  });

  it("does not send a paragraph that is both typed in and deleted", () => {
    expect(pendingEdits(new Map([[3, "x"]]), new Set([3]), [])).toEqual({
      edits: [],
      deleted: [3],
      inserts: [],
    });
  });

  it("edits a paragraph that has text, and nothing else", () => {
    // A table is drawn from joined cell strings and cannot be mapped back to its cells; a paragraph
    // with no runs has no text node for the writer to put anything into.
    expect(isEditableBlock(paragraph("a"), true)).toBe(true);
    expect(isEditableBlock({ kind: "table", rows: [["a"]] }, true)).toBe(false);
    expect(
      isEditableBlock({ kind: "paragraph", index: 0, heading: null, list: null, runs: [] }, true),
    ).toBe(false);
    // A read that stopped at the ceiling may not be written back at all.
    expect(isEditableBlock(paragraph("a"), false)).toBe(false);
  });

  it("numbers a list item by the paragraph it came from, not by its place in the list", () => {
    // The list element is drawn here; the ordinal has to survive that, or deleting an item would
    // delete a different paragraph.
    const groups = groupBlocks([
      paragraph("one", { list: { ordered: false, level: 0 }, index: 4 }),
      paragraph("two", { list: { ordered: false, level: 0 }, index: 5 }),
    ]);
    const items = groups[0].kind === "list" ? groups[0].items : [];
    expect(items.map((item) => item.index)).toEqual([4, 5]);
  });
});
