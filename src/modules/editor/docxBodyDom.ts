import type { BlockKind, DraftBlock } from "./docxBlocks";
import { readBlocks } from "./docxBlocks";

/** Elements that end the line they are in when the browser creates them inside a block. */
const LINE_BREAKERS = new Set(["BR", "DIV", "P", "LI", "H1", "H2", "H3", "H4", "H5", "H6"]);

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

/** The blocks of the body as the model wants them, in document order. */
export function readDraftBlocks(body: HTMLElement): DraftBlock[] {
  return readBlocks(
    [...body.children]
      .filter(
        (child): child is HTMLElement =>
          child instanceof HTMLElement && child.hasAttribute("data-block"),
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
  if (!block.querySelector("br, div, p, li, h1, h2, h3, h4, h5, h6")) return null;
  const kind = (block.getAttribute("data-block") ?? "p") as BlockKind;
  const lines: HTMLElement[] = [];
  let line = freshBlock(block, kind);
  const push = () => {
    lines.push(line);
    line = freshBlock(block, kind);
  };
  for (const node of [...block.childNodes]) {
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
  // Trailing empties are what a `<br>` at the end leaves behind: a document does not end in a blank
  // line because the browser put one there.
  while (lines.length > 1 && lines[lines.length - 1].childNodes.length === 0) {
    lines.pop();
  }
  return lines;
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
export function normalizeBody(body: HTMLElement): void {
  // A bare element (Enter's own `<div>`) is a block of whatever the block above it was.
  for (const child of [...body.childNodes]) {
    if (child instanceof HTMLElement && child.hasAttribute("data-block")) continue;
    if (child instanceof HTMLElement) {
      const previous = child.previousElementSibling as HTMLElement | null;
      const kind = (previous?.getAttribute("data-block") ?? "p") as BlockKind;
      child.setAttribute("data-block", kind);
      if (kind === "li" && previous?.dataset.list) {
        child.setAttribute("data-list", previous.dataset.list);
        if (previous.dataset.numId) {
          child.setAttribute("data-num-id", previous.dataset.numId);
        }
      }
      continue;
    }
    if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim() === "") {
      body.removeChild(child);
      continue;
    }
    // Stray text directly under the body: give it a paragraph of its own.
    const wrap = document.createElement("div");
    wrap.setAttribute("data-block", "p");
    body.replaceChild(wrap, child);
    wrap.appendChild(child);
  }

  for (const block of [...body.children]) {
    if (!(block instanceof HTMLElement)) continue;
    const lines = splitLines(block);
    if (!lines) continue;
    for (const line of lines) body.insertBefore(line, block);
    body.removeChild(block);
  }

  if (body.children.length === 0) {
    body.appendChild(freshBlock(body, "p"));
  }

  markLists(body);
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
  for (const block of body.children) {
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

/** How far into the body's text the caret is, counting every block's characters in order. */
export function caretOffsetIn(body: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!body.contains(range.startContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(body);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

/** Put the caret back at a character offset into the body's text. */
export function placeCaretIn(body: HTMLElement, offset: number): void {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    remaining -= length;
    node = walker.nextNode();
  }
  const last = body.lastElementChild;
  if (!last) return;
  const range = document.createRange();
  range.selectNodeContents(last);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
