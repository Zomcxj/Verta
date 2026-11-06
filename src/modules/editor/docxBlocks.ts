import type { DocxDocument, DocxEdit, DocxInsert } from "@/lib/native";

/**
 * What a block of the body is, in the flat shape the pane draws and the writer understands.
 *
 * The pane keeps one editable surface, so the block-level structure has to be readable back out of
 * the DOM: each direct child carries the kind it was drawn as, and a child the browser created on its
 * own inherits the kind of the block above it.
 */
export type BlockKind =
  | "p"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "li"
  | "table";

/** One block as the pane has it on screen right now. */
export type DraftBlock = {
  kind: BlockKind;
  /** Bullet or numbered, for a list item only. */
  list: "bullet" | "number" | null;
  /** The numbering definition, so two lists next to each other do not share a counter. */
  numId: number | null;
  text: string;
};

/** A block as the file has it: it knows which paragraph it came from. */
export type BaselineBlock = DraftBlock & { ordinal: number | null };

const KINDS: ReadonlySet<string> = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "table",
]);

/** Beyond this many blocks on either side the LCS is skipped and leftovers pair up in order. */
const MAX_LCS = 800;

/**
 * The kind a row of the DOM claims, falling back to the block above it.
 *
 * The browser makes its own elements when Enter, Backspace or a paste splits a block: they carry no
 * `data-block`, and they are the same kind of line as the one they grew out of - a new line under a
 * heading is another heading, one under a list item continues the list.
 */
export function kindFromDataset(
  dataset: Record<string, string | undefined>,
  fallback: BlockKind,
): Pick<DraftBlock, "kind" | "list" | "numId"> {
  const claimed = dataset.block;
  const kind =
    claimed && KINDS.has(claimed) ? (claimed as BlockKind) : fallback;
  if (kind !== "li") return { kind, list: null, numId: null };
  const numId = dataset.numId ? Number.parseInt(dataset.numId, 10) : Number.NaN;
  return {
    kind,
    list: dataset.list === "number" ? "number" : "bullet",
    numId: Number.isFinite(numId) ? numId : null,
  };
}

/** The rows of the editable body, in document order. */
export function readBlocks(
  rows: { dataset: Record<string, string | undefined>; text: string }[],
  fallback: BlockKind,
): DraftBlock[] {
  const blocks: DraftBlock[] = [];
  for (const row of rows) {
    const claimed = row.dataset.block;
    if (claimed && KINDS.has(claimed)) {
      blocks.push({
        ...kindFromDataset(row.dataset, fallback),
        text: row.text,
      });
    } else {
      const previous = blocks[blocks.length - 1];
      const kind = previous?.kind ?? fallback;
      blocks.push({
        kind,
        list: kind === "li" ? (previous?.list ?? "bullet") : null,
        numId: kind === "li" ? (previous?.numId ?? null) : null,
        text: row.text,
      });
    }
  }
  return blocks;
}

/** The blocks a read produced, as the baseline the DOM is compared against. */
export function blocksFromDocument(document: DocxDocument): BaselineBlock[] {
  return document.blocks.map((block) => {
    if (block.kind === "table") {
      // A table has no paragraph ordinal of its own: it is drawn, and it is not editable, so it never
      // takes part in what is written back.
      return {
        kind: "table",
        list: null,
        numId: null,
        text: "",
        ordinal: null,
      };
    }
    const kind: BlockKind = block.heading
      ? (`h${block.heading}` as BlockKind)
      : block.list
        ? "li"
        : "p";
    return {
      kind,
      list: block.list ? (block.list.ordered ? "number" : "bullet") : null,
      numId: block.list ? block.list.numId : null,
      text: block.runs.map((run) => run.text).join(""),
      ordinal: block.index,
    };
  });
}

/**
 * Whether two texts are the same as far as the file is concerned.
 *
 * The DOM writes some typed spaces as U+00A0 (a second one, a trailing one), so the draft flattens
 * them back to spaces. A paragraph the file itself wrote with a real no-break space would then never
 * compare equal, and every save would re-send it and rewrite its spacing although nobody had touched
 * it. The two are one character here.
 */
const sameText = (left: string, right: string) =>
  left === right || flattenSpaces(left) === flattenSpaces(right);

const flattenSpaces = (text: string) => text.replace(/ /g, " ");

const sameBlock = (left: DraftBlock, right: DraftBlock) =>
  left.kind === right.kind &&
  left.list === right.list &&
  left.numId === right.numId &&
  sameText(left.text, right.text);

/**
 * True when the pane has to read the file again after this write.
 *
 * A text edit leaves the ordinals alone. A block added, joined or removed moves every ordinal after
 * it, and the pane addresses paragraphs by ordinal, so it cannot type into what it has until it has
 * read the numbering back.
 */
export function needsReread(
  baseline: BaselineBlock[],
  draft: DraftBlock[],
): boolean {
  const written = writable(baseline);
  if (written.length !== draft.length) return true;
  return written.some(
    (block, index) =>
      block.kind !== draft[index].kind ||
      block.list !== draft[index].list ||
      block.numId !== draft[index].numId,
  );
}

/**
 * The blocks the writer can address.
 *
 * A table is drawn, not typed into, and it has no paragraph ordinal: counting one as a block would
 * report every paragraph after it as moved - a re-read after every keystroke, and an alignment that
 * pairs a paragraph with a table.
 */
function writable(blocks: BaselineBlock[]): BaselineBlock[] {
  return blocks.filter((block) => block.kind !== "table");
}

/**
 * What to send the writer: the paragraphs that were retyped, the ones that were removed, and the ones
 * that were added.
 *
 * The ends that are identical are dropped first, then the middle is matched by longest common
 * subsequence so a line keeps its own paragraph - and with it its style and numbering - while its
 * neighbours are being edited. What is left over pairs up in order as a retype, so fixing a typo is
 * one edit rather than a deletion plus an insertion.
 */
export function alignBlocks(
  all: BaselineBlock[],
  draft: DraftBlock[],
): { edits: DocxEdit[]; deleted: number[]; inserts: DocxInsert[] } {
  const baseline = writable(all);
  const edits: DocxEdit[] = [];
  const deleted: number[] = [];
  const inserts: DocxInsert[] = [];

  let head = 0;
  while (
    head < baseline.length &&
    head < draft.length &&
    sameBlock(baseline[head], draft[head])
  ) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < baseline.length - head &&
    tail < draft.length - head &&
    sameBlock(
      baseline[baseline.length - 1 - tail],
      draft[draft.length - 1 - tail],
    )
  ) {
    tail += 1;
  }

  const from = writable(baseline).slice(head, baseline.length - tail);
  const to = draft.slice(head, draft.length - tail);

  /** The paragraph a new block goes after: the last one still in the file, or the top of the body. */
  let anchor: number | null = head > 0 ? baseline[head - 1].ordinal : null;

  const matches =
    from.length > MAX_LCS || to.length > MAX_LCS
      ? []
      : commonSubsequence(from, to);

  let b = 0;
  let d = 0;
  const settle = (untilBase: number, untilDraft: number) => {
    // The stretch between two matched blocks: the pairs in it are retypes of the same line, the rest
    // of the baseline is gone, and the rest of the draft is new.
    const pairs = Math.min(untilBase - b, untilDraft - d);
    for (let i = 0; i < pairs; i += 1) {
      const block = from[b + i];
      const next = to[d + i];
      if (block.ordinal === null) continue;
      if (!sameBlock(block, next)) {
        edits.push({ index: block.ordinal, text: next.text });
      }
      anchor = block.ordinal;
    }
    for (let i = b + pairs; i < untilBase; i += 1) {
      const block = from[i];
      if (block.ordinal !== null) deleted.push(block.ordinal);
    }
    for (let i = d + pairs; i < untilDraft; i += 1) {
      inserts.push({ after: anchor, text: to[i].text });
    }
    b = untilBase;
    d = untilDraft;
  };

  for (const [matchBase, matchDraft] of matches) {
    settle(matchBase, matchDraft);
    anchor = from[matchBase].ordinal ?? anchor;
    b = matchBase + 1;
    d = matchDraft + 1;
  }
  settle(from.length, to.length);

  return { edits, deleted, inserts };
}

/**
 * The baseline after a write that sent exactly this draft.
 *
 * The ordinals come from the blocks the file had *before* the write, filtered the same way the draft
 * is: a table is in the read and not in the draft, so copying ordinals across the unfiltered list
 * shifts every paragraph after a table onto its neighbour - and the paragraph that was actually
 * typed in drops out of the comparison, which is how a document ends up "saved" with nothing written.
 */
export function adoptDraft(
  before: BaselineBlock[],
  draft: DraftBlock[],
): BaselineBlock[] {
  const written = writable(before);
  return draft.map((block, index) => ({
    ...block,
    ordinal: written[index]?.ordinal ?? null,
  }));
}

/** Pairs of indexes (into `from`, into `to`) that are equal, longest such run. */
function commonSubsequence(
  from: DraftBlock[],
  to: DraftBlock[],
): [number, number][] {
  const rows = from.length;
  const columns = to.length;
  // A flat table: widths of the longest common subsequence of the suffixes, filled bottom-right to
  // top-left so the walk below can read it forwards.
  const table = new Uint16Array((rows + 1) * (columns + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      const at = i * (columns + 1) + j;
      table[at] = sameBlock(from[i], to[j])
        ? table[(i + 1) * (columns + 1) + j + 1] + 1
        : Math.max(
            table[(i + 1) * (columns + 1) + j],
            table[i * (columns + 1) + j + 1],
          );
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (sameBlock(from[i], to[j])) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (
      table[(i + 1) * (columns + 1) + j] >= table[i * (columns + 1) + j + 1]
    ) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}
