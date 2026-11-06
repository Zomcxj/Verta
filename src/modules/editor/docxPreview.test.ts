import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tableGrid } from "./DocxPreview";

const here = path.dirname(fileURLToPath(import.meta.url));
const pane = readFileSync(path.join(here, "EditorPane.tsx"), "utf8");
const preview = readFileSync(path.join(here, "DocxPreview.tsx"), "utf8");
const body = readFileSync(path.join(here, "docxBodyDom.ts"), "utf8");

describe("docx tables", () => {
  it("numbers the rows and cells so each has a key of its own", () => {
    expect(tableGrid([["a", "b"], ["c"]])).toEqual([
      {
        id: 0,
        cells: [
          { id: 0, text: "a" },
          { id: 1, text: "b" },
        ],
      },
      { id: 1, cells: [{ id: 0, text: "c" }] },
    ]);
  });
});

/** The routing lives in the editor pane, and what has to hold is static: a `.docx` goes to the
 *  reader, a `.doc` says why it cannot, and the document scrolls with the bar the rest of the
 *  rendered documents have. */
describe("docx routing in the editor pane", () => {
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
      pane.indexOf(
        "const view = cmRef.current?.view;",
        pane.indexOf("undo: () => {"),
      ),
    );
  });
});

describe("the document body is one editable surface", () => {
  it("collects the whole body into one editable surface", () => {
    // One contentEditable for the document, not one per paragraph: a caret cannot move between two
    // editable elements, so cross-paragraph selection, Backspace at the start of a line and deleting
    // several lines at once were all impossible by construction.
    expect(preview).toMatch(/data-docx-body=""/);
    expect(preview).toMatch(/contentEditable=\{editable\}/);
    expect(preview).not.toMatch(/function EditableText/);
    // The paragraph's ordinal is still on the block, because the probes and the writer speak in it.
    expect(preview).toMatch(
      /data-docx-editable=\{block\.ordinal \?\? undefined\}/,
    );
  });

  it("leaves Enter, Backspace and the selection to the browser", () => {
    // Only paste is intercepted: an input method composing inside a hand-rolled editor is how a
    // Chinese input method gets broken.
    expect(preview).toMatch(/onBeforeInput/);
    expect(preview).toMatch(/insertFromPaste/);
    expect(preview).toMatch(/insertFromDrop/);
    expect(preview).not.toMatch(/onSplit/);
    expect(preview).not.toMatch(/event\.key !== "Enter"/);
  });

  it("normalises the DOM after the browser has edited it", () => {
    expect(preview).toMatch(/normalizeBody\(body\)/);
    expect(preview).toMatch(/readDraftBlocks\(body\)/);
    // Flattening rebuilds nodes, so the caret is carried across it - by line and offset within it,
    // because the end of a line and the start of the empty line below it are the same text offset.
    const handlerAt = preview.indexOf("onInput={");
    const normalizeAt = preview.indexOf("normalizeBody(body)", handlerAt);
    const restoreAt = preview.indexOf(
      "placeCaretAtBlock(body, caret.position, caret.offset)",
      normalizeAt,
    );
    expect(handlerAt).toBeGreaterThan(-1);
    expect(normalizeAt).toBeGreaterThan(handlerAt);
    expect(restoreAt).toBeGreaterThan(normalizeAt);
    // The offset-only pair is gone: it is what put the caret back at the end of the line above.
    expect(preview).not.toMatch(/placeCaretIn\(/);
    expect(preview).not.toMatch(/caretOffsetIn\(/);
    expect(body).toMatch(/export function normalizeBody/);
    expect(body).toMatch(/export function markLists/);
  });

  it("treats a line the browser created as the kind of the line above it", () => {
    // Enter's own `<div>` carries nothing; under a heading it is another heading, under a list item
    // it continues the list with the same numbering definition.
    expect(body).toMatch(/child\.setAttribute\("data-block", kind\)/);
    expect(body).toMatch(/"data-num-id", previous\.dataset\.numId/);
  });

  it("does not touch the caret while an input method is composing", () => {
    // Chromium fires `input` for every composition update. Re-installing a selection on each of them
    // is how a pinyin input method ends up committing one character at a time, so composition is
    // left alone, and so is a normalisation that changed nothing.
    expect(preview).toMatch(/isComposing/);
    expect(body).toMatch(
      /export function normalizeBody\(body: HTMLElement\): boolean/,
    );
  });

  it("leaves a paste alone when the clipboard has no text", () => {
    // `preventDefault` before the check swallowed every paste that was not plain text (an image, a
    // table copied from a page) and did nothing with it.
    const pasteAt = preview.indexOf("insertFromPaste");
    const emptyAt = preview.indexOf("if (!text) return;", pasteAt);
    const preventAt = preview.indexOf("event.preventDefault();", pasteAt);
    expect(emptyAt).toBeGreaterThan(pasteAt);
    expect(emptyAt).toBeLessThan(preventAt);
  });

  it("keeps typing that happened while a structural save was in flight", () => {
    // The re-read rebuilds the body from the file, so anything typed after the snapshot but before
    // the write landed would simply vanish from the pane.
    expect(preview).toMatch(/leftover/);
    expect(preview).toMatch(/for \(let attempt = 0; attempt < 3/);
  });

  it("writes nothing for a body that has not changed", () => {
    // A save that sends nothing is a save that rewrites the whole archive and pushes an undo step
    // that takes back nothing.
    expect(preview).toMatch(
      /if \(edits\.length === 0 && deleted\.length === 0 && inserts\.length === 0\) \{/,
    );
  });

  it("puts the caret back in the line it was in, not at that text offset", () => {
    // Enter at the end of a line leaves the caret in the new empty one. Restored by text offset it
    // landed at the end of the line above - the two positions have the same offset, because an empty
    // block adds no characters - and the next keystroke typed into the wrong paragraph.
    expect(body).toMatch(/export function caretInBody/);
    expect(body).toMatch(/export function placeCaretAtBlock/);
    expect(preview).toMatch(/caretInBody\(body\)/);
    expect(preview).toMatch(/placeCaretAtBlock\(/);
  });

  it("re-reads only when a write moved the blocks around", () => {
    expect(preview).toMatch(/needsReread\(/);
    expect(preview).toMatch(/baseline\.current = adoptDraft\(before, draft\)/);
  });
});
