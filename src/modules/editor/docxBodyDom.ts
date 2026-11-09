import type { BlockKind, DraftBlock } from "./docxBlocks";
import { readBlocks } from "./docxBlocks";

/** Elements that end the line they are in when the browser creates them inside a block. */
const LINE_BREAKERS = new Set([
  "BR",
  "DIV",
  "P",
  "LI",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
]);

/**
 * The text of one block, which is what the writer stores.
 *
 * `textContent`, not `innerText`: `innerText` honours CSS (a hidden block would read as empty) and it
 * costs a layout on every keystroke. The browser's own line breaks are flattened into blocks by
 * `normalizeBody` before this is ever asked, so a block holds one line.
 */
export function textOfBlock(block: HTMLElement): string {
  return (block.textContent ?? "").replace(/\u00a0/g, " ");
}

/**
 * The surfaces a document is drawn in: one per page, or the container itself before any pages exist.
 *
 * A page is where a block lives - pagination moves each block into the page it starts on - so the
 * blocks are one level below the container. A document that has not been measured yet has no pages,
 * and then the container is the single surface, which is how the same code reads a body that has just
 * been drawn.
 */
export function surfacesOf(container: HTMLElement): HTMLElement[] {
  const pages = [...container.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.hasAttribute("data-docx-page"),
  );
  return pages.length > 0 ? pages : [container];
}

/** Whether a node in a surface is furniture rather than the document: the page number, a rule. */
function isChrome(node: HTMLElement): boolean {
  return node.hasAttribute("data-docx-chrome");
}

/**
 * Everything a surface holds, in document order, across the pages.
 *
 * Tables and notes are in here too: they are not something the writer can take (see
 * `readDraftBlocks`), but they are children of the surface, and a block's place in the document is
 * counted with them - the caret is remembered and put back by that same count.
 */
export function blocksOf(container: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const surface of surfacesOf(container)) {
    for (const child of surface.children) {
      if (child instanceof HTMLElement && !isChrome(child)) out.push(child);
    }
  }
  return out;
}

/** The blocks of the document as the model wants them, in document order. */
export function readDraftBlocks(body: HTMLElement): DraftBlock[] {
  return readBlocks(
    blocksOf(body)
      .filter(
        (block) =>
          block.hasAttribute("data-block") &&
          // A table is drawn from joined cell strings, and a note is the text of a footnote, which
          // lives in a part of its own. Neither has an ordinal and neither is something the writer
          // can take, so neither is part of what is read back.
          block.getAttribute("data-block") !== "table" &&
          block.getAttribute("data-block") !== "note",
      )
      .map((block) => ({
        dataset: block.dataset,
        text: textOfBlock(block),
      })),
    "p",
  );
}

/**
 * The node's own line, as a fresh block: the attributes of the block it came out of, with nothing on
 * the paragraph ordinal - the next read is what numbers it.
 */
function freshBlock(source: HTMLElement, kind: BlockKind): HTMLElement {
  const block = document.createElement("div");
  block.setAttribute("data-block", kind);
  const list = source.dataset.list;
  if (kind === "li" && list) block.setAttribute("data-list", list);
  const numId = source.dataset.numId;
  if (kind === "li" && numId) block.setAttribute("data-num-id", numId);
  return block;
}

/**
 * The lines inside one block.
 *
 * Everything the browser can do while typing - a soft break, a pasted multiline string, Enter inside
 * an inline element - ends up as a `<br>` or a nested block element. Each of those ends the line, and
 * the model has one line per paragraph, so they are cut apart here. `null` means one line already.
 */
function splitLines(block: HTMLElement): HTMLElement[] | null {
  if (!block.querySelector("br, div, p, li, h1, h2, h3, h4, h5, h6"))
    return null;
  const kind = (block.getAttribute("data-block") ?? "p") as BlockKind;
  const lines: HTMLElement[] = [];
  let line = freshBlock(block, kind);
  const push = () => {
    lines.push(line);
    line = freshBlock(block, kind);
  };
  const children = [...block.childNodes];
  // Exactly one trailing `<br>` is the browser's way of keeping a caret in an empty last line: it
  // ends the line rather than starting another. Dropping only that one is what lets a real blank
  // line survive - the loop this replaced took every empty line at the end, so two Enters came back
  // as none.
  if (children[children.length - 1]?.nodeName === "BR") children.pop();
  for (const node of children) {
    if (node instanceof HTMLElement && LINE_BREAKERS.has(node.tagName)) {
      if (node.tagName === "BR") {
        push();
        continue;
      }
      // A nested block: its own lines belong to the outer sequence, in order.
      for (const inner of nestedLines(node)) {
        for (const content of inner) line.appendChild(content);
        push();
      }
      // The nested element's last line is empty when it ended with a break; keep it as a line.
      continue;
    }
    line.appendChild(node);
  }
  lines.push(line);
  // One line is not a split: replacing the block for that would throw away the `<br>` that gives an
  // empty line somewhere for the caret to sit.
  return lines.length > 1 ? lines : null;
}

/** The children of a nested block, as line contents. */
function nestedLines(node: HTMLElement): Node[][] {
  const lines: Node[][] = [[]];
  for (const child of [...node.childNodes]) {
    if (child instanceof HTMLElement && LINE_BREAKERS.has(child.tagName)) {
      if (child.tagName === "BR") {
        lines.push([]);
        continue;
      }
      for (const inner of nestedLines(child)) {
        lines[lines.length - 1].push(...inner);
        lines.push([]);
      }
      continue;
    }
    lines[lines.length - 1].push(child);
  }
  if (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  return lines;
}

/**
 * Make the DOM say what the model says: one direct child per paragraph, in order.
 *
 * The browser answers Enter, Backspace and a paste in its own way - a bare `<div>`, a `<br>`, a
 * nested `<p>` - and nothing in the writer can take those. Whatever it made is flattened into the one
 * shape the pane reads back. Only structure is touched: text nodes are moved, never rewritten, so the
 * input method's composition is not disturbed.
 */
export function normalizeBody(body: HTMLElement): boolean {
  const surfaces = surfacesOf(body);
  let changed = false;
  for (const surface of surfaces) {
    if (normalizeSurface(surface)) changed = true;
  }
  // A node the browser left beside the pages rather than in one - a paste, or a keystroke that
  // landed with no block to land in. The document is what is between the pages, so it is moved into
  // the page it was typed next to: the one above it, or the first page when it is above them all.
  // Where it ends up in that page does not matter: the next pagination puts it where it measures.
  if (surfaces[0] !== body) {
    let target = surfaces[0];
    for (const node of [...body.childNodes]) {
      if (node instanceof HTMLElement && node.hasAttribute("data-docx-page")) {
        target = node;
        continue;
      }
      if (node instanceof HTMLElement) {
        target.appendChild(node);
        changed = true;
        continue;
      }
      if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() === "") {
        body.removeChild(node);
        continue;
      }
      // Stray text beside the pages: give it a paragraph of its own, in the page it was typed in.
      changed = true;
      const wrap = document.createElement("div");
      wrap.setAttribute("data-block", "p");
      body.replaceChild(wrap, node);
      wrap.appendChild(node);
      target.appendChild(wrap);
    }
  }
  if (blocksOf(body).length === 0) {
    surfaces[0].appendChild(freshBlock(body, "p"));
    changed = true;
  }
  markLists(body);
  return changed;
}

/** One surface's own children, flattened into one block per paragraph. */
function normalizeSurface(surface: HTMLElement): boolean {
  let changed = false;
  // A bare element (Enter's own `<div>`) is a block of whatever the block above it was.
  for (const child of [...surface.childNodes]) {
    if (child instanceof HTMLElement && (child.hasAttribute("data-block") || isChrome(child)))
      continue;
    if (child instanceof HTMLElement) {
      const previous = child.previousElementSibling as HTMLElement | null;
      const kind = (previous?.getAttribute("data-block") ?? "p") as BlockKind;
      child.setAttribute("data-block", kind);
      changed = true;
      if (kind === "li" && previous?.dataset.list) {
        child.setAttribute("data-list", previous.dataset.list);
        if (previous.dataset.numId) {
          child.setAttribute("data-num-id", previous.dataset.numId);
        }
      }
      continue;
    }
    if (
      child.nodeType === Node.TEXT_NODE &&
      (child.textContent ?? "").trim() === ""
    ) {
      surface.removeChild(child);
      continue;
    }
    // Stray text directly under the surface: give it a paragraph of its own.
    changed = true;
    const wrap = document.createElement("div");
    wrap.setAttribute("data-block", "p");
    surface.replaceChild(wrap, child);
    wrap.appendChild(child);
  }

  for (const block of [...surface.children]) {
    if (!(block instanceof HTMLElement)) continue;
    const lines = splitLines(block);
    if (!lines) continue;
    changed = true;
    for (const line of lines) surface.insertBefore(line, block);
    surface.removeChild(block);
  }
  return changed;
}

/**
 * Number what the list items show, in the DOM rather than in the text.
 *
 * The marker is a pseudo-element (see `globals.css`), so it is never part of a paragraph's text: a
 * copied line does not carry it, and the writer never sees it. Word numbers per numbering definition,
 * so the counter restarts whenever the definition changes.
 */
export function markLists(body: HTMLElement): void {
  let numId: string | null = null;
  let count = 0;
  // One numbering across the whole document, so a list that runs over a page break keeps counting:
  // the pages hold the blocks but the number is the document's.
  for (const block of blocksOf(body)) {
    if (!(block instanceof HTMLElement)) continue;
    const kind = block.getAttribute("data-block");
    if (kind !== "li") {
      numId = null;
      count = 0;
      block.removeAttribute("data-marker");
      continue;
    }
    const id = block.getAttribute("data-num-id");
    if (id !== numId) {
      numId = id;
      count = 0;
    }
    count += 1;
    const ordered = block.getAttribute("data-list") === "number";
    block.setAttribute("data-marker", ordered ? `${count}.` : "•");
    block.classList.add("verta-docx-marker");
  }
}

/** A place in the document: which block, and how far into that block's text. */
export type BlockPlace = { position: number; offset: number };

/** Which block the caret is in, and how far into it: the position survives a re-read, an offset
 *  shared by two blocks does not (the end of a line and the start of the empty one below it are the
 *  same text offset). */
export function caretInBody(body: HTMLElement): BlockPlace | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return placeOf(body, range.startContainer, range.startOffset);
}

/**
 * The selection as two places in the document.
 *
 * Pagination moves the blocks, and a range does not survive the node it points into being moved:
 * what is carried across is this pair, in the same vocabulary the caret uses - both ends, because a
 * selection is not a caret and collapsing one is not something the pane may do on its own.
 */
export function selectionInBody(
  body: HTMLElement,
): { anchor: BlockPlace; focus: BlockPlace } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  if (!selection.anchorNode || !selection.focusNode) return null;
  const anchor = placeOf(body, selection.anchorNode, selection.anchorOffset);
  const focus = placeOf(body, selection.focusNode, selection.focusOffset);
  if (!anchor || !focus) return null;
  return { anchor, focus };
}

/** Where one node position sits in the document, by block and by text before it. */
function placeOf(body: HTMLElement, node: Node, offset: number): BlockPlace | null {
  const block = ownerBlock(body, node);
  if (!block) return null;
  const position = blocksOf(body).indexOf(block);
  if (position < 0) return null;
  const start = document.createRange();
  start.selectNodeContents(block);
  start.setEnd(node, offset);
  return { position, offset: start.toString().length };
}

/**
 * Puts a selection back where it was, after the blocks it points into have been moved.
 *
 * The anchor is placed first and the focus extended to: the browser keeps which end of a selection
 * is the caret, and a selection that is extended backwards has to stay backwards.
 */
export function placeSelection(
  body: HTMLElement,
  anchor: BlockPlace,
  focus: BlockPlace | null,
): void {
  placeCaretAtBlock(body, anchor.position, anchor.offset);
  if (!focus) return;
  const blocks = blocksOf(body);
  if (blocks.length === 0) return;
  const block = blocks[Math.min(focus.position, blocks.length - 1)];
  const located = textPositionIn(block, focus.offset);
  const selection = window.getSelection();
  if (located && selection) selection.extend(located.node, located.offset);
}

/**
 * The block a node sits in.
 *
 * A block is a child of a page, and a page is a child of the container, so the search stops at the
 * first ancestor that a surface holds. A caret that sits between two blocks belongs to no block, and
 * nothing is the honest answer for it: the offset of a block is what is being carried, and there is
 * no block to carry it to.
 */
function ownerBlock(body: HTMLElement, node: Node): HTMLElement | null {
  const surfaces = new Set(surfacesOf(body));
  for (let at: Node | null = node; at && at !== body; at = at.parentNode) {
    if (!(at.parentNode instanceof HTMLElement) || !surfaces.has(at.parentNode)) continue;
    return at instanceof HTMLElement && !surfaces.has(at) ? at : null;
  }
  return null;
}

/** Put the caret back into a block by its position in the document. */
export function placeCaretAtBlock(
  body: HTMLElement,
  position: number,
  offset: number,
): void {
  const blocks = blocksOf(body);
  if (blocks.length === 0) return;
  const block = blocks[Math.min(position, blocks.length - 1)];
  const located = textPositionIn(block, offset);
  if (located) {
    setCaret(located.node, located.offset);
    return;
  }
  // An empty line has no text node to sit in, and a caret placed on the element itself is
  // canonicalised by the browser to the nearest text position - the end of the line above - so
  // typing after Enter went into the previous paragraph. A `<br>` last in the line gives it a
  // position of its own; last, because the line also holds what it draws but does not own (the
  // delete affordance is `contenteditable=false`, so a caret in front of it belongs nowhere).
  //
  // A line that already ends in a `<br>` - drawn empty, or left by the browser's own Enter - is not
  // given a second one: two of them are two lines, and the caret between them is at the end of the
  // first, so the next keystroke started a new paragraph instead of filling this one.
  if (block.lastChild?.nodeName !== "BR") block.appendChild(document.createElement("br"));
  setCaret(block, block.childNodes.length - 1);
}

/** Where `offset` characters into a block's own text is, skipping what the block only draws. */
function textPositionIn(
  block: HTMLElement,
  offset: number,
): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('[contenteditable="false"]')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  let remaining = offset;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return { node: node as Text, offset: remaining };
    remaining -= length;
  }
  return null;
}

function setCaret(node: Node, offset: number): void {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
