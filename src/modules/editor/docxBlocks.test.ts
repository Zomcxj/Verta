import type { DocxDocument, DocxInsert } from "@/lib/native";
import { describe, expect, it } from "vitest";
import {
  adoptDraft,
  alignBlocks,
  type BaselineBlock,
  blocksFromDocument,
  type DraftBlock,
  kindFromDataset,
  needsReread,
  readBlocks,
} from "./docxBlocks";

const p = (text: string, ordinal: number | null): BaselineBlock => ({
  kind: "p",
  list: null,
  numId: null,
  text,
  ordinal,
});
const draft = (text: string): DraftBlock => ({
  kind: "p",
  list: null,
  numId: null,
  text,
});

describe("block alignment", () => {
  it("reports a typed paragraph and nothing else", () => {
    // The common case: one line changed, and the other lines must not be re-sent - the writer takes
    // them as "replace this paragraph's text", which would flatten their formatting.
    expect(
      alignBlocks([p("one", 0), p("two", 1)], [draft("one"), draft("TWO")]),
    ).toEqual({ edits: [{ index: 1, text: "TWO" }], deleted: [], inserts: [] });
  });

  it("turns a removed block into a deletion", () => {
    expect(
      alignBlocks(
        [p("one", 0), p("two", 1), p("three", 2)],
        [draft("one"), draft("three")],
      ),
    ).toEqual({ edits: [], deleted: [1], inserts: [] });
  });

  it("anchors a new line to the block it follows", () => {
    // Enter in the middle: what it was typed in stays, the tail becomes the new paragraph after it.
    expect(
      alignBlocks(
        [p("one", 0), p("two", 1)],
        [draft("one"), draft("tail"), draft("two")],
      ),
    ).toEqual({
      edits: [],
      deleted: [],
      inserts: [{ after: 0, text: "tail" }],
    });
  });

  it("anchors a new first line to nothing", () => {
    expect(alignBlocks([p("one", 0)], [draft("new"), draft("one")])).toEqual({
      edits: [],
      deleted: [],
      inserts: [{ after: null, text: "new" }],
    });
  });

  it("keeps the order of several new lines", () => {
    expect(
      alignBlocks([p("one", 0)], [draft("one"), draft("a"), draft("b")]),
    ).toEqual({
      edits: [],
      deleted: [],
      inserts: [
        { after: 0, text: "a" },
        { after: 0, text: "b" },
      ],
    });
  });

  it("pairs a removed and an added block as one edit when the counts match", () => {
    // A typo fixed in place must not read as "delete the paragraph, insert another": that would drop
    // its style and its numbering, and cost two writes where one belongs.
    expect(
      alignBlocks([p("one", 0), p("tow", 1)], [draft("one"), draft("two")]),
    ).toEqual({ edits: [{ index: 1, text: "two" }], deleted: [], inserts: [] });
  });

  it("leaves a table out of the comparison entirely", () => {
    // A table has no paragraph ordinal and cannot be written back, so it is neither an edit nor a
    // deletion: counting it as a block would report every paragraph after it as moved.
    const table: BaselineBlock = {
      kind: "table",
      list: null,
      numId: null,
      text: "",
      ordinal: null,
    };
    expect(
      alignBlocks(
        [p("one", 0), table, p("two", 1)],
        [draft("one"), draft("TWO")],
      ),
    ).toEqual({ edits: [{ index: 1, text: "TWO" }], deleted: [], inserts: [] });
    expect(needsReread([p("one", 0), table], [draft("ONE")])).toBe(false);
  });

  it("does not send a paragraph that is unchanged", () => {
    expect(alignBlocks([p("one", 0)], [draft("one")])).toEqual({
      edits: [],
      deleted: [],
      inserts: [],
    });
  });

  it("clears the body when everything was selected and deleted", () => {
    expect(alignBlocks([p("one", 0), p("two", 1)], [])).toEqual({
      edits: [],
      deleted: [0, 1],
      inserts: [],
    });
  });

  it("adds a line to an empty body", () => {
    expect(alignBlocks([], [draft("first")])).toEqual({
      edits: [],
      deleted: [],
      inserts: [{ after: null, text: "first" }],
    });
  });

  it("anchors a new line to the last block that survived a deletion", () => {
    // The line Enter created sits after the paragraph that was removed; its anchor has to be the one
    // that is still in the file, or the writer refuses an insert after a deleted paragraph.
    expect(
      alignBlocks(
        [p("one", 0), p("two", 1), p("three", 2)],
        [draft("one"), draft("three"), draft("four")],
      ),
    ).toEqual({
      edits: [],
      deleted: [1],
      inserts: [{ after: 2, text: "four" }],
    });
  });

  it("keeps a list item's numbering id out of the edits", () => {
    // Committed blocks carry what they were drawn with: an untouched list item is not re-sent.
    const item: BaselineBlock = {
      kind: "li",
      list: "number",
      numId: 7,
      text: "item",
      ordinal: 0,
    };
    const { ordinal: _ordinal, ...draftItem } = item;
    expect(alignBlocks([item], [draftItem])).toEqual({
      edits: [],
      deleted: [],
      inserts: [],
    });
  });
});

describe("a no-break space in the file", () => {
  it("is not an edit when the pane reads it back as a space", () => {
    // The DOM turns some typed spaces into U+00A0 (a trailing one, a second one), so the draft has
    // its spaces flattened. A paragraph the file wrote with a real no-break space then read back as
    // "a b" while the baseline said "a\u{a0}b" - not equal, so every save re-sent that paragraph and
    // rewrote its spacing even though nothing in it had been touched.
    const read = blocksFromDocument({
      blocks: [
        {
          kind: "paragraph",
          index: 0,
          heading: null,
          list: null,
          runs: [
            {
              text: "a\u{a0}b",
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
            },
          ],
          align: null,
          size: null,
          indent: null,
          spacing: null,
        },
      ],
      page: null,
      truncated: false,
      editable: true,
      undrawnPictures: 0,
      guard: { size: 1, modifiedMs: 1 },
    });
    expect(alignBlocks(read, [draft("a b")])).toEqual({ edits: [], deleted: [], inserts: [] });
  });
});

describe("adopting what was just written", () => {
  it("keeps the ordinals right when the document has a table", () => {
    // The draft has no table block (a table cannot be written back), the baseline has one. Copying
    // ordinals across by index therefore shifts every paragraph after a table: the next save names
    // the wrong paragraph, and with nothing marked as changed it names none at all - the pane says
    // 已保存 while the file has not moved.
    const table: BaselineBlock = {
      kind: "table",
      list: null,
      numId: null,
      text: "",
      ordinal: null,
    };
    const before = [p("a", 0), table, p("b", 1), p("c", 2)];
    const typed = [draft("a"), draft("B"), draft("c")];
    expect(adoptDraft(before, typed)).toEqual([
      p("a", 0),
      p("B", 1),
      p("c", 2),
    ]);
    // And the next save sees the paragraph it changed, not a neighbour.
    expect(
      alignBlocks(adoptDraft(before, typed), [
        draft("a"),
        draft("BB"),
        draft("c"),
      ]),
    ).toEqual({
      edits: [{ index: 1, text: "BB" }],
      deleted: [],
      inserts: [],
    });
  });
});

describe("blocks from a read", () => {
  it("gives headings and list items their own kind", () => {
    const blocks = blocksFromDocument({
      blocks: [
        {
          kind: "paragraph",
          index: 0,
          heading: 2,
          list: null,
          runs: [{ text: "a", bold: false, italic: true, underline: false }],
        },
        {
          kind: "paragraph",
          index: 1,
          heading: null,
          list: { ordered: true, level: 0, numId: 7 },
          runs: [{ text: "b", bold: false, italic: false, underline: false }],
        },
        { kind: "table", rows: [["a"]] },
      ],
      page: null,
      truncated: false,
      editable: true,
      undrawnPictures: 0,
      guard: { size: 1, modifiedMs: 1 },
    } as DocxDocument);
    expect(blocks[0]).toMatchObject({ kind: "h2", text: "a", ordinal: 0 });
    expect(blocks[1]).toMatchObject({
      kind: "li",
      list: "number",
      numId: 7,
      text: "b",
      ordinal: 1,
    });
    expect(blocks[2]).toMatchObject({ kind: "table", ordinal: null, text: "" });
  });

  it("keeps an empty paragraph as a blank line", () => {
    const blocks = blocksFromDocument({
      blocks: [
        {
          kind: "paragraph",
          index: 0,
          heading: null,
          list: null,
          runs: [],
          align: null,
          size: null,
          indent: null,
          spacing: null,
        },
      ],
      page: null,
      truncated: false,
      editable: true,
      undrawnPictures: 0,
      guard: { size: 1, modifiedMs: 1 },
    } as DocxDocument);
    expect(blocks).toEqual([p("", 0)]);
  });
});

describe("blocks from the DOM", () => {
  it("takes the kind a block carries", () => {
    expect(kindFromDataset({ block: "h3" }, "p")).toEqual({
      kind: "h3",
      list: null,
      numId: null,
    });
  });

  it("treats a block the browser made as the one before it", () => {
    // Enter produces a bare <div>: it is a paragraph of whatever the block above it was.
    expect(kindFromDataset({}, "h2")).toEqual({
      kind: "h2",
      list: null,
      numId: null,
    });
  });

  it("keeps the numbering id and the list kind from the dataset", () => {
    expect(
      kindFromDataset({ block: "li", list: "number", numId: "7" }, "p"),
    ).toEqual({
      kind: "li",
      list: "number",
      numId: 7,
    });
  });

  it("does not invent a numbering id", () => {
    expect(kindFromDataset({ block: "li", list: "bullet" }, "p")).toEqual({
      kind: "li",
      list: "bullet",
      numId: null,
    });
  });

  it("reads the rows in order", () => {
    expect(
      readBlocks(
        [
          { dataset: { block: "p" }, text: "one" },
          { dataset: {}, text: "two" },
        ],
        "p",
      ),
    ).toEqual([draft("one"), draft("two")]);
  });

  it("lets a bare row follow a heading", () => {
    // The browser's own Enter gives a <div> with nothing on it; under a heading it is a heading.
    expect(
      readBlocks(
        [
          { dataset: { block: "h2" }, text: "title" },
          { dataset: {}, text: "body" },
        ],
        "p",
      ),
    ).toEqual([
      { kind: "h2", list: null, numId: null, text: "title" },
      { kind: "h2", list: null, numId: null, text: "body" },
    ]);
  });
});

describe("when the pane has to read again", () => {
  it("says so when the block count changed", () => {
    expect(needsReread([p("one", 0)], [draft("one"), draft("two")])).toBe(true);
  });

  it("says so when a block changed kind", () => {
    expect(
      needsReread(
        [p("one", 0)],
        [{ kind: "h1", list: null, numId: null, text: "one" }],
      ),
    ).toBe(true);
  });

  it("says no for a text-only change", () => {
    expect(needsReread([p("one", 0)], [draft("ONE")])).toBe(false);
  });
});

/** The writer's shapes, checked here so the two sides cannot drift apart silently. */
describe("what the writer is handed", () => {
  it("hands a plain array of edits, ordinals and inserts", () => {
    const result = alignBlocks([p("one", 0)], [draft("ONE"), draft("new")]);
    const inserts: DocxInsert[] = result.inserts;
    expect(result.edits).toEqual([{ index: 0, text: "ONE" }]);
    expect(inserts).toEqual([{ after: 0, text: "new" }]);
  });
});

describe("a footnote", () => {
  const note = (
    text: string,
    source: "footnote" | "endnote" | "comment" = "footnote",
    author?: string,
  ): DocxDocument["blocks"][number] => ({ kind: "note", source, text, author });
  const paragraph = (index: number, text: string): DocxDocument["blocks"][number] => ({
    kind: "paragraph",
    index,
    heading: null,
    list: null,
    runs: [
      {
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
      },
    ],
    align: null,
    size: null,
    indent: null,
    spacing: null,
  });
  const document = (blocks: DocxDocument["blocks"]): DocxDocument => ({
    blocks,
    page: null,
    truncated: false,
    editable: true,
    undrawnPictures: 0,
    guard: { size: 0, modifiedMs: 0 },
  });

  it("is drawn with its text but has no paragraph ordinal", () => {
    const read = blocksFromDocument(
      document([paragraph(0, "cited"), note("a note"), paragraph(1, "after")]),
    );
    expect(read.map((block) => [block.kind, block.text, block.ordinal])).toEqual([
      ["p", "cited", 0],
      ["note", "a note", null],
      ["p", "after", 1],
    ]);
    // And what kind of note it is, which is what the pane calls it.
    expect(read[1].source).toBe("footnote");
  });

  it("keeps the name of whoever wrote a comment", () => {
    // A comment is someone talking about the text, so the pane has to be able to say who.
    const read = blocksFromDocument(
      document([paragraph(0, "cited"), note("check this", "comment", "A. Reviewer")]),
    );
    expect(read[1].source).toBe("comment");
    expect(read[1].author).toBe("A. Reviewer");
    // A footnote names nobody, and the pane says nothing about an author then.
    expect(blocksFromDocument(document([paragraph(0, "cited"), note("a note")]))[1].author).toBe(
      undefined,
    );
  });

  it("is not part of what is written back", () => {
    // The note's text lives in the footnotes part, not in the paragraph. If the note counted as a
    // block the writer can address, the draft - which never holds one - would look one block short
    // and every save would delete a paragraph.
    const baseline = blocksFromDocument(
      document([paragraph(0, "cited"), note("a note"), paragraph(1, "after")]),
    );
    const draft: DraftBlock[] = [
      { kind: "p", list: null, numId: null, text: "cited" },
      { kind: "p", list: null, numId: null, text: "after" },
    ];
    expect(alignBlocks(baseline, draft)).toEqual({
      edits: [],
      deleted: [],
      inserts: [],
    });
  });
});
