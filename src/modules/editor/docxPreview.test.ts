import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DocxRun } from "@/lib/native";
import {
  blockStyle,
  DEFAULT_PAGE,
  fallbackPx,
  fittedPageScale,
  runStyle,
  tableGrid,
} from "./DocxPreview";

const here = path.dirname(fileURLToPath(import.meta.url));
const pane = readFileSync(path.join(here, "EditorPane.tsx"), "utf8");
const preview = readFileSync(path.join(here, "DocxPreview.tsx"), "utf8");
const body = readFileSync(path.join(here, "docxBodyDom.ts"), "utf8");

describe("a nested list item", () => {
  it("is drawn one step in from its parent", () => {
    // The file says which level each item is on. Ignoring it puts a sub-item at the same margin as
    // its parent, which reads as one flat list - and the numbering restarts looking wrong.
    expect(preview).toMatch(/read\.list\?\.level/);
    expect(preview).toMatch(/data-level=/);
    expect(preview).toMatch(/paddingLeft/);
  });
});

/** A paragraph as the reader hands it to the pane. */
const paragraph = (
  over: Partial<Parameters<typeof blockStyle>[1] & object> = {},
): Parameters<typeof blockStyle>[1] => ({
  kind: "paragraph",
  index: 0,
  heading: null,
  list: null,
  runs: [],
  align: null,
  size: null,
  indent: null,
  spacing: null,
  ...over,
});

describe("a block's box", () => {
  it("takes its alignment, indents and spacing from the file", () => {
    // Twips are Word's unit (1/20 pt) and the pane draws in CSS pixels: 15 twips to the pixel, so
    // 720 twips is a 48px left indent and a 360-twip first-line indent is 24px.
    const style = blockStyle(
      "p",
      paragraph({
        align: "center",
        size: 12,
        indent: { left: 720, firstLine: 360 },
        spacing: { before: 240, after: 120, line: 360, lineRule: "auto" },
      }),
    );
    expect(style.textAlign).toBe("center");
    expect(style.fontSize).toBe("16px");
    expect(style.paddingLeft).toBe("48px");
    expect(style.textIndent).toBe("24px");
    expect(style.marginTop).toBe("16px");
    expect(style.marginBottom).toBe("8px");
    // `auto` is a multiple of a line (240 = single): 360/240 of 12pt, times Word's 1.2 line.
    expect(style.lineHeight).toBe("29px");
  });

  it("gives an empty paragraph a line's height", () => {
    // This is the blank line. Drawn with no height the paragraph collapses: two Enters look like
    // none, and the caret has nowhere to sit on the line that was added.
    const style = blockStyle("p", paragraph());
    const height = Math.round(fallbackPx("p") * 1.45);
    expect(style.minHeight).toBe(`${height}px`);
    expect(style.lineHeight).toBe(`${height}px`);
    expect(height).toBeGreaterThan(14);
  });

  it("draws a heading's fallback bigger than a body line", () => {
    expect(fallbackPx("h1")).toBeGreaterThan(fallbackPx("h2"));
    expect(fallbackPx("h2")).toBeGreaterThan(fallbackPx("p"));
  });

  it("uses A4 when the document names no section", () => {
    expect(DEFAULT_PAGE).toEqual({
      width: 11906,
      height: 16838,
      marginTop: 1440,
      marginRight: 1440,
      marginBottom: 1440,
      marginLeft: 1440,
    });
  });
});

describe("the document on its paper", () => {
  it("draws a sheet the size of the section, with the margins as padding", () => {
    expect(preview).toMatch(/data-docx-paper/);
    expect(preview).toMatch(/twipsToPx\(page\.width/);
    expect(preview).toMatch(/paddingTop: `\$\{twipsToPx\(page\.marginTop/);
  });

  it("keeps a blank line instead of trimming it away", () => {
    // The bug the user hit: the flattening dropped every empty line at the end of a block, so two
    // Enters came back as none. Only the one `<br>` the browser puts at the end of a line may go.
    expect(body).not.toMatch(/while \(lines\.length > 1/);
    expect(body).toMatch(/children\[children\.length - 1\]\?\.nodeName === "BR"/);
    // And an empty paragraph is drawn with something in it, or it has no height at all.
    expect(preview).toMatch(/read\.runs\.length > 0 \? \(\s*<Runs\s+runs=\{read\.runs\}/);
    expect(preview).toMatch(/\) : \(\s*<br \/>/);
  });
});

describe("pictures the pane cannot draw", () => {
  it("says how many rather than leaving the page with a hole in it", () => {
    // A metafile (WMF/EMF) is what Word shows an equation or a pasted chart as, and no webview
    // decodes one. The reader cannot turn it into an image, so the pane draws nothing there - and a
    // document that is missing a figure it should have reads as a document that lost it.
    expect(preview).toMatch(/undrawnPictures/);
    expect(preview).toMatch(/editor\.docx\.undrawnPictures/);
    expect(preview).toMatch(/data-docx-undrawn/);
  });
});

describe("docx tables", () => {
  it("numbers the rows and cells so each has a key of its own", () => {
    const run = (text: string) => ({
      text,
      bold: false,
      italic: false,
      underline: false,
              strike: false,
      size: null,
      color: null,
      font: null,
      image: null,
      imageWidth: null,
      imageHeight: null,
    });
    // A cell is its runs and the fill it states, because a shaded header row is drawn shaded.
    expect(
      tableGrid([
        [{ runs: [run("a")], shade: "#b5cc82" }, { runs: [run("b")] }],
        [{ runs: [run("c")] }],
      ]),
    ).toEqual([
      {
        id: 0,
        cells: [
          { id: 0, runs: [run("a")], shade: "#b5cc82" },
          { id: 1, runs: [run("b")], shade: undefined },
        ],
      },
      { id: 1, cells: [{ id: 0, runs: [run("c")], shade: undefined }] },
    ]);
  });

  it("draws a cell's runs rather than one flat string", () => {
    // A header row is bold because its runs are: a cell drawn as a string lost that.
    expect(preview).toMatch(/<Runs\s+runs=\{cell\.runs\}/);
  });
});

/** The routing lives in the editor pane, and what has to hold is static: a `.docx` goes to the
 *  reader, a `.doc` says why it cannot, and the document scrolls with the bar the rest of the
 *  rendered documents have. */
describe("how the pane saves", () => {
  it("does not put a save banner over the document", () => {
    // A text file has no banner: the tab's dot says "unsaved" and goes away when it is written. A
    // document that said 已保存 at the top not only differed, it pushed the page down when the
    // banner appeared and up again when it left.
    expect(preview).not.toMatch(/editor\.docx\.saved/);
    expect(preview).not.toMatch(/editor\.docx\.saving/);
    // The state is still readable for the probes; it is just not drawn.
    expect(preview).toMatch(/data-docx-save=\{save\.kind\}/);
  });

  it("waits as long as the editor's own setting says", () => {
    // Two panes disagreeing about "stopped typing" is the kind of thing nobody can explain.
    expect(preview).toMatch(/state\.editorAutoSaveDelay/);
    expect(preview).toMatch(/delayRef\.current\)/);
    // And autosave off means autosave off: typing waits for the pane to lose focus.
    expect(preview).toMatch(/if \(!autoSaveRef\.current\) return;/);
  });

  it("re-reads for the numbering without rebuilding the page", () => {
    // Entering a line writes at once and re-reads for the numbering. The read replaces the
    // baseline and nothing else: rendering it would re-key every block after the one that moved,
    // which is what made the page flash and the following line jump.
    const at = preview.indexOf("if (reread) {");
    expect(at).toBeGreaterThan(-1);
    const block = preview.slice(at, at + 700);
    expect(block).toMatch(/baseline\.current = blocksFromDocument\(next\)/);
    expect(block).not.toMatch(/setReloadKey/);
    expect(block).not.toMatch(/setState/);
  });

  it("tells the shell what it owes the file", () => {
    // The tab's dot, the close prompt and 保存 all hang off this one signal.
    expect(preview).toMatch(/onDirtyChange\?\.\(dirty\)/);
    expect(preview).toMatch(/markDirty\(true\)/);
    expect(preview).toMatch(/markDirty\(false\)/);
  });
});

describe("docx routing in the editor pane", () => {
  it("sends .docx to the reader, whatever the text read said about the file", () => {
    // The check sits before the file-read status branches: an archive is not text, so the reader is
    // what decides whether it can be read - not the text sniffer, whose answer for a `.docx` whose
    // bytes happen to be text (or which is empty) is "text" and used to open it in the source editor.
    expect(pane).toMatch(/if \(fileExt === "docx"\) \{/);
    expect(pane).toMatch(/<DocxPreview\s+ref=\{docxRef\}\s+path=\{path\}/);
    // The tab is told what the document owes the file, exactly as it is for a text buffer.
    expect(pane).toMatch(/onDirtyChange=\{onDirtyChange\}/);
    const readerAt = pane.indexOf('if (fileExt === "docx") {');
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

describe("fitting a page to the pane", () => {
  it("shrinks a page that is wider than the pane", () => {
    // A slide exported into a document is 1700 CSS pixels wide, which is wider than the pane: drawn
    // at its own width inside a centred row it overflowed both sides and its left edge could not be
    // scrolled to at all.
    expect(fittedPageScale(1700, 1200)).toBeCloseTo(1200 / 1700, 6);
  });

  it("leaves a page that already fits at its own size", () => {
    // An A4 page is 794 pixels: the document is not a slide, and enlarging it would be a different
    // document than the one the file describes.
    expect(fittedPageScale(794, 1200)).toBe(1);
    expect(fittedPageScale(794, 794)).toBe(1);
  });

  it("draws at its own size before the pane has been measured", () => {
    // The first frame has no measurement; scaling by a width of zero would draw nothing.
    expect(fittedPageScale(1700, 0)).toBe(1);
    expect(fittedPageScale(0, 1200)).toBe(1);
  });
});

/** A run as the reader hands it to the pane, with nothing stated but what the test names. */
const run = (over: Partial<DocxRun> = {}): DocxRun => ({
  text: "x",
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  size: null,
  color: null,
  font: null,
  image: null,
  imageWidth: null,
  imageHeight: null,
  ...over,
});

describe("what a run is drawn as", () => {
  it("puts a raised run above the line and a lowered one below it", () => {
    // 12056 runs in the documents to hand say where they sit, and drawing them all on the line
    // flattens every unit like m2 and every citation mark.
    expect(runStyle(run({ vertical: "superscript" }))).toMatchObject({
      verticalAlign: "super",
    });
    expect(runStyle(run({ vertical: "subscript" }))).toMatchObject({ verticalAlign: "sub" });
    // Word draws them smaller, and a run with no size of its own inherits one, so the scale is
    // expressed against whatever it inherits.
    expect(runStyle(run({ vertical: "superscript" })).fontSize).toBe("0.65em");
    // A run that states a size has that size scaled instead.
    expect(runStyle(run({ vertical: "superscript", size: 10 }))).toMatchObject({
      fontSize: expect.stringMatching(/^\d+px$/),
    });
    expect(runStyle(run())).not.toHaveProperty("verticalAlign");
  });

  it("draws an underline and a strike as one decoration with two lines", () => {
    // Two declarations of `text-decoration-line` would replace each other, so a run that is both
    // underlined and struck through has to say both at once.
    expect(runStyle(run({ underline: true })).textDecorationLine).toBe("underline");
    expect(runStyle(run({ strike: true })).textDecorationLine).toBe("line-through");
    expect(runStyle(run({ underline: true, strike: true })).textDecorationLine).toBe(
      "underline line-through",
    );
    expect(runStyle(run())).not.toHaveProperty("textDecorationLine");
  });

  it("paints the shading a run sits on, under the marker when there is one", () => {
    // A run's own fill is what a marked-up passage often uses instead of a highlight; a highlight is
    // the marker over that, so it is the one that shows when both are stated.
    expect(runStyle(run({ shade: "#f7f8fa" }))).toMatchObject({ backgroundColor: "#f7f8fa" });
    expect(runStyle(run({ shade: "#f7f8fa", highlight: "yellow" }))).toMatchObject({
      backgroundColor: "#ffff00",
    });
    expect(runStyle(run())).not.toHaveProperty("backgroundColor");
  });

  it("paints the marker colour the file names, and nothing for a name it does not know", () => {
    expect(runStyle(run({ highlight: "yellow" }))).toMatchObject({ backgroundColor: "#ffff00" });
    expect(runStyle(run({ highlight: "CYAN" }))).toMatchObject({ backgroundColor: "#00ffff" });
    // A highlight of `none` never reaches here, and a name from another writer is not painted.
    expect(runStyle(run({ highlight: "chartreuse" }))).not.toHaveProperty("backgroundColor");
  });
});
