import {
  native,
  type DocxBlock,
  type DocxDocument,
  type DocxGuard,
  type DocxRun,
} from "@/lib/native";
import { useT } from "@/modules/i18n";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  adoptDraft,
  alignBlocks,
  type BaselineBlock,
  blocksFromDocument,
  needsReread,
} from "./docxBlocks";
import {
  caretInBody,
  normalizeBody,
  placeCaretAtBlock,
  readDraftBlocks,
} from "./docxBodyDom";

/**
 * A Word document, drawn from the blocks the Rust side read out of it - and edited in place.
 *
 * A `.docx` is a ZIP, so the editor could only call it a binary file. The archive is opened in Rust
 * (see `src-tauri/src/modules/docx.rs`) and arrives here as paragraphs, lists and tables: no HTML
 * passthrough, so nothing in the document can inject anything into the window, and no parser in this
 * bundle.
 *
 * The whole body is one editable surface, not one per paragraph. A caret cannot move between two
 * editable elements, so a paragraph each made cross-paragraph selection, Backspace at the start of a
 * line, and deleting several lines at once impossible by construction. Here Enter, Backspace, the
 * selection and the input method all belong to the browser; only paste is intercepted, and after every
 * edit the DOM is flattened back into the one shape the writer understands - a direct child per
 * paragraph (see `docxBodyDom.ts`).
 *
 * Saving happens on its own shortly after typing stops, back into the same file. What is sent is the
 * difference against what the file already has, so an untouched paragraph keeps every byte Word wrote
 * for it, and an edit lands in the paragraph it was typed in.
 *
 * What the reader does not carry - images, text boxes, footnotes - is simply not drawn; a document
 * whose meaning is in a picture will read as its captions.
 */

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; document: DocxDocument }
  | { kind: "error"; message: string };

/** What the pane is doing about the file on disk. */
type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "failed"; message: string }
  /** The file changed under us. Saving again would overwrite whatever changed it. */
  | { kind: "stale"; message: string };

/** The table's rows and cells, numbered so each has a key of its own. */
export function tableGrid(
  rows: DocxRun[][][],
): { id: number; cells: { id: number; runs: DocxRun[] }[] }[] {
  return rows.map((row, rowIndex) => ({
    id: rowIndex,
    cells: row.map((runs, cellIndex) => ({ id: cellIndex, runs })),
  }));
}

const HEADING_CLASS = [
  "text-[19px] font-semibold",
  "text-[17px] font-semibold",
  "text-[15px] font-semibold",
  "text-[13.5px] font-semibold",
  "text-[13px] font-semibold",
  "text-[12.5px] font-semibold",
] as const;

/** How long typing has to stop before the file is written. */
/**
 * How long typing has to stop before the file is written.
 *
 * The editor's own setting, so the two panes agree about what "stopped typing" means.
 */
const SAVE_DELAY_FALLBACK_MS = 600;

/** The drag payload that carries a picture's number, so a drop knows what it is holding. */
const PICTURE_DRAG = "application/x-verta-picture";

/** A list where order is the only identity there is: each entry gets the position as its id. */
function numbered<T>(items: T[]): { id: number; item: T }[] {
  return items.map((item, id) => ({ id, item }));
}

function Runs({
  runs,
  onDeleteImage,
  canMove,
}: {
  runs: DocxRun[];
  /** Given when these runs belong to a paragraph the writer can address. */
  onDeleteImage?: (imageIndex: number) => void;
  /** Whether a picture here may be picked up and dropped on another paragraph. */
  canMove?: boolean;
}) {
  const t = useT();
  return (
    <>
      {/* A paragraph's runs are an ordered list with no identity of their own; the text is the only
          thing that distinguishes them, and duplicates are legitimate. */}
      {numbered(runs).map(({ id, item: run }) => (
        <span
          key={id}
          className={[
            run.bold ? "font-semibold" : "",
            run.italic ? "italic" : "",
            run.underline ? "underline" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{
            // The file's own numbers only, and never a fallback: a run that says nothing inherits
            // from its block, where the paragraph's size already is.
            ...(run.size ? { fontSize: `${Math.round(pointsToPx(run.size))}px` } : {}),
            ...(run.color ? { color: run.color } : {}),
            ...(run.font ? { fontFamily: `"${run.font}", sans-serif` } : {}),
          }}
        >
          {run.image ? (
            // A picture is drawn from the archive's own bytes; it carries no text, so writing the
            // paragraph back leaves it where Word put it.
            // biome-ignore lint/a11y/noStaticElementInteractions: the picture is the document's own content, not a control: it is dragged with the mouse the way an image is in Word, and nothing is lost when it is not.
            <span
              className="group/picture relative inline-block align-top"
              // A control inside an editable surface: the removal must not put the caret into the
              // picture and leave a keystroke waiting there.
              contentEditable={false}
              draggable={canMove === true && run.imageIndex != null}
              onDragStart={(event) => {
                if (run.imageIndex == null) return;
                event.dataTransfer.setData(PICTURE_DRAG, String(run.imageIndex));
                event.dataTransfer.effectAllowed = "move";
              }}
            >
              <img
                src={run.image}
                alt=""
                data-docx-image=""
                style={{
                  width: run.imageWidth ? `${Math.round(run.imageWidth)}px` : undefined,
                  height: run.imageHeight ? `${Math.round(run.imageHeight)}px` : undefined,
                  maxWidth: "100%",
                }}
                className="inline-block align-top"
              />
              {onDeleteImage && run.imageIndex != null ? (
                <button
                  type="button"
                  data-docx-image-delete={run.imageIndex}
                  title={t("editor.docx.deleteImage")}
                  aria-label={t("editor.docx.deleteImage")}
                  // Without this the click moves the caret before the handler runs.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onDeleteImage(run.imageIndex as number)}
                  className="absolute -right-2 -top-2 rounded-full bg-background/90 p-0.5 text-muted-foreground opacity-0 shadow transition-opacity hover:bg-accent hover:text-foreground group-hover/picture:opacity-100"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
                </button>
              ) : null}
            </span>
          ) : (
            run.text
          )}
        </span>
      ))}
    </>
  );
}

const BLOCK_CLASS: Record<string, string> = {
  p: "group/block relative first:mt-0",
  li: "group/block relative pl-6",
  table: "my-3 overflow-x-auto",
};

/** A4 in twips, and the margins Word starts from; a document that names its own section wins. */
export const DEFAULT_PAGE = {
  width: 11906,
  height: 16838,
  marginTop: 1440,
  marginRight: 1440,
  marginBottom: 1440,
  marginLeft: 1440,
};

/** How many page breaks are marked before the rest are left alone, so a huge file stays cheap. */
const MAX_PAGE_BREAKS = 400;

/** Twips (1/20 pt) to CSS pixels at 96 dpi - 15 twips to the pixel. */
const twipsToPx = (twips: number) => twips / 15;

/**
 * The scale a document's page is drawn at so that it fits the pane.
 *
 * A page wider than the pane - a landscape sheet, or a slide exported into a document - was drawn at
 * its own width inside a centred row, so it overflowed both sides and its left edge could not be
 * scrolled to. Fitting it to the pane keeps the page whole. A page that already fits is left at its
 * own size: nothing here enlarges, because a document is not a slide to be projected.
 */
export function fittedPageScale(pageWidth: number, available: number): number {
  if (pageWidth <= 0 || available <= 0) return 1;
  return pageWidth > available ? available / pageWidth : 1;
}

/** A point size to CSS pixels at 96 dpi. */
const pointsToPx = (points: number) => (points * 4) / 3;

/** Word's alignment names, in CSS. */
const ALIGN: Record<string, string> = {
  left: "left",
  start: "left",
  center: "center",
  right: "right",
  end: "right",
  both: "justify",
  distribute: "justify",
};

/** The size a block falls back to when the file does not say: an 11pt body, per heading level. */
export function fallbackPx(kind: string): number {
  if (kind.startsWith("h")) {
    const level = Number.parseInt(kind.slice(1), 10);
    return [25, 22, 20, 18, 17, 16][level - 1] ?? 16;
  }
  return pointsToPx(11);
}

/**
 * One block's box, from what the file says about it.
 *
 * A paragraph with nothing in it is still a paragraph: Word gives it a line's height, and a blank
 * line is exactly that. Drawn with no height it collapses, which is both why two Enters looked like
 * none and why the caret had nowhere to sit on an empty line.
 */
export function blockStyle(
  kind: string,
  read?: Extract<DocxBlock, { kind: "paragraph" }> | null,
): React.CSSProperties {
  const size = read?.size ? pointsToPx(read.size) : fallbackPx(kind);
  const style: React.CSSProperties = {};
  if (read?.size) style.fontSize = `${Math.round(size)}px`;
  const align = read?.align ? ALIGN[read.align] : undefined;
  if (align) style.textAlign = align as React.CSSProperties["textAlign"];
  const indent = read?.indent;
  if (indent?.left) style.paddingLeft = `${twipsToPx(indent.left)}px`;
  if (indent?.firstLine) style.textIndent = `${twipsToPx(indent.firstLine)}px`;
  const spacing = read?.spacing;
  if (spacing?.before !== null && spacing?.before !== undefined) {
    style.marginTop = `${twipsToPx(spacing.before)}px`;
  }
  if (spacing?.after !== null && spacing?.after !== undefined) {
    style.marginBottom = `${twipsToPx(spacing.after)}px`;
  }
  // `auto` is a multiple of a line (240 = single), anything else is an exact height in twips.
  const line =
    spacing?.line === null || spacing?.line === undefined
      ? null
      : spacing.lineRule === "exact" || spacing.lineRule === "atLeast"
        ? twipsToPx(spacing.line)
        : size * 1.2 * (spacing.line / 240);
  const height = Math.round(line ?? size * 1.45);
  style.lineHeight = `${height}px`;
  style.minHeight = `${height}px`;
  return style;
}

function classOf(block: BaselineBlock): string {
  if (block.kind === "table") return BLOCK_CLASS.table;
  if (block.kind === "li") return BLOCK_CLASS.li;
  if (block.kind === "p") return BLOCK_CLASS.p;
  const level = Number.parseInt(block.kind.slice(1), 10);
  return `group/block relative mt-4 mb-1.5 first:mt-0 ${HEADING_CLASS[level - 1] ?? ""}`;
}

/**
 * Where one page's worth of text ends and the next begins, in the paper's own pixels.
 *
 * The body is one continuous column, so a page ends at a multiple of the text area: the page height
 * less its top and bottom margins. The break is then moved up to the top of the block that would
 * have crossed it, which is what Word does and what keeps the line from being cut in half.
 *
 * Written as arithmetic over block extents rather than over the DOM, so the rule can be tested
 * without a browser.
 */
export function pageBreaks(
  blocks: readonly (readonly [number, number])[],
  textArea: number,
  limit: number,
): number[] {
  if (textArea <= 0) return [];
  const breaks: number[] = [];
  let next = textArea;
  for (const [start, bottom] of blocks) {
    while (bottom > next && breaks.length < limit) {
      // A block taller than a page starts one page and then the next, so the same offset must not
      // be recorded twice.
      if (breaks[breaks.length - 1] !== start && start > 0) breaks.push(start);
      next += textArea;
    }
  }
  return breaks;
}

/** Every top-level block of a body as the two numbers `pageBreaks` reads, in the paper's pixels. */
function blockExtents(
  body: HTMLElement,
  scale: number,
): [number, number][] {
  if (scale <= 0) return [];
  const top = body.getBoundingClientRect().top;
  const out: [number, number][] = [];
  for (const child of Array.from(body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    const rect = child.getBoundingClientRect();
    // `zoom` scales what the browser reports, and the text area is stated unscaled.
    out.push([(rect.top - top) / scale, (rect.bottom - top) / scale]);
  }
  return out;
}

/**
 * The document body: one editable surface for the whole document.
 *
 * Deliberately uncontrolled. React re-renders this pane whenever the save status changes, and a
 * re-render would put the runs as they were read back over what the user just typed. So the body is
 * drawn once per read (`key={reloadKey}` in the parent) and the typed text lives in the DOM until it
 * is written to the file.
 */
const DocxBody = memo(function DocxBody({
  doc,
  editable,
  bodyRef,
  available,
  onEdited,
  onDelete,
  onDeleteImage,
  onMoveImage,
}: {
  doc: DocxDocument;
  editable: boolean;
  bodyRef: React.RefObject<HTMLDivElement | null>;
  /** The room the pane has, so a page wider than it is drawn to fit rather than clipped. */
  available: number;
  onEdited: () => void;
  onDelete: (ordinal: number) => void;
  /** Takes one picture out, named by the number the reader gave it. */
  onDeleteImage: (drawing: number) => void;
  /** Puts one picture at the end of a paragraph, named the way an edit names one. */
  onMoveImage: (drawing: number, to: number) => void;
}) {
  const t = useT();
  const blocks = useMemo(() => blocksFromDocument(doc), [doc]);
  /** Where each page ends, in the paper's own pixels. Drawn, never written: the body is untouched. */
  const [breaks, setBreaks] = useState<number[]>([]);

  useEffect(() => {
    // Markers are pseudo-elements, so they have to be assigned before the first paint as well as
    // after every edit.
    if (bodyRef.current) normalizeBody(bodyRef.current);
  }, [bodyRef]);


  const deleteButton = (ordinal: number | null) =>
    editable && ordinal !== null ? (
      <button
        type="button"
        contentEditable={false}
        data-docx-delete={ordinal}
        title={t("editor.docx.deleteParagraph")}
        aria-label={t("editor.docx.deleteParagraph")}
        // A button inside an editable surface: without this the click moves the caret and the
        // paragraph is the one that gets the focus.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onDelete(ordinal)}
        className="absolute -left-5 top-1 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/block:opacity-60"
      >
        {/* An icon rather than a "×": the character would be part of the paragraph's own text, and
            copying the document would carry it along. */}
        <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
      </button>
    ) : null;

  const page = { ...DEFAULT_PAGE, ...(doc.page ?? {}) };
  const pageWidth = twipsToPx(page.width ?? DEFAULT_PAGE.width);
  // A page wider than the pane is shrunk to fit it; a page that fits is drawn at its own size.
  const scale = fittedPageScale(pageWidth, available);
  const marginTop = twipsToPx(page.marginTop ?? DEFAULT_PAGE.marginTop);
  const textArea =
    twipsToPx(page.height ?? DEFAULT_PAGE.height) -
    marginTop -
    twipsToPx(page.marginBottom ?? DEFAULT_PAGE.marginBottom);
  const paper = {
    width: `${pageWidth}px`,
    minHeight: `${twipsToPx(page.height ?? DEFAULT_PAGE.height)}px`,
    paddingTop: `${twipsToPx(page.marginTop ?? DEFAULT_PAGE.marginTop)}px`,
    paddingRight: `${twipsToPx(page.marginRight ?? DEFAULT_PAGE.marginRight)}px`,
    paddingBottom: `${twipsToPx(page.marginBottom ?? DEFAULT_PAGE.marginBottom)}px`,
    paddingLeft: `${twipsToPx(page.marginLeft ?? DEFAULT_PAGE.marginLeft)}px`,
    // `zoom` rather than a transform: it shrinks the page's own layout, so its width, its margins
    // and its type all come down together and the row it sits in centres what is actually drawn.
    zoom: scale,
  };

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () =>
      setBreaks(pageBreaks(blockExtents(body, scale), textArea, MAX_PAGE_BREAKS));
    measure();
    // Typing changes how tall the body is, and a page break is a question about that height.
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [bodyRef, textArea, scale]);

  return (
    // The paper is the frame; the editable surface inside it is the document. Word's page is what a
    // reader recognises, and the margins are where the text stops.
    <div className="flex justify-center py-5">
      <div
        data-docx-paper=""
        style={paper}
        // The paper is white and the document's ink is its own: Word's text is black unless the
        // document says otherwise, and the app's foreground is a light colour in the dark theme -
        // inherited here it drew the whole page in near-white on white.
        className="relative shrink-0 bg-white text-[13px] leading-relaxed text-black shadow-[0_1px_3px_rgba(0,0,0,0.16)]"
      >
        {/* Where a page ends. A sibling of the editable body rather than a child of it: a marker
            inside that surface would be text the browser could put a caret next to, and would be
            read back as part of the document. */}
        {breaks.map((offset, at) => (
          <div
            key={offset}
            data-docx-page-break={at + 2}
            contentEditable={false}
            aria-hidden
            className="pointer-events-none absolute inset-x-0 border-t border-dashed border-black/15"
            style={{ top: marginTop + offset }}
          >
            <span className="absolute -top-[7px] right-1 bg-white px-1 text-[9.5px] tabular-nums text-black/35">
              {at + 2}
            </span>
          </div>
        ))}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: this is the document itself, not a control: the editable surface is what the browser gives a caret and an input method to, and its handlers exist to keep the DOM readable back */}
        <div
          ref={bodyRef}
      data-docx-body=""
      contentEditable={editable}
      suppressContentEditableWarning
      spellCheck={false}
      onBeforeInput={(event) => {
        const native = event.nativeEvent as InputEvent;
        if (
          native.inputType !== "insertFromPaste" &&
          native.inputType !== "insertFromDrop"
        ) {
          return;
        }
        // Only paste is taken over: an input method composing in a hand-rolled editor is how a
        // Chinese input method gets broken, so everything else is left to the browser.
        const text = native.dataTransfer?.getData("text/plain") ?? "";
        // Checked before the default is cancelled: a paste with no text in it (an image, a table
        // copied from a page) is left to the browser rather than swallowed and dropped.
        if (!text) return;
        event.preventDefault();
        const lines = text.split(/\r?\n/);
        // `insertText` is deprecated and still the only way to put text in without destroying the
        // browser's own editing state (a raw range insertion loses the undo stack and the caret).
        document.execCommand("insertText", false, lines[0]);
        for (const line of lines.slice(1)) {
          document.execCommand("insertParagraph");
          if (line) document.execCommand("insertText", false, line);
        }
      }}
      onInput={(event) => {
        const body = event.currentTarget;
        // An input method fires this for every composition update, and re-installing a selection in
        // the middle of one is how pinyin gets committed a character at a time. Composition is left
        // entirely to the browser.
        if ((event.nativeEvent as InputEvent).isComposing) {
          onEdited();
          return;
        }
        // Flattening may rebuild nodes, so the caret is remembered by line and offset within it and
        // put back - but only when something was rebuilt. A caret that is already where the browser
        // left it is not touched.
        const caret = caretInBody(body);
        if (normalizeBody(body) && caret) {
          placeCaretAtBlock(body, caret.position, caret.offset);
        }
        onEdited();
      }}
      onBlur={() => {
        // Leaving the document is as good a moment as stopping typing.
        onEdited();
      }}
      className="outline-none"
    >
      {blocks.map((block, index) => {
        if (block.kind === "table") {
          const table = doc.blocks[index];
          if (table?.kind !== "table") return null;
          // A table has no ordinal and nothing else to be known by: its place in the body is its
          // identity, and the body is drawn once per read, so that place never moves underneath it.
          const tableKey = `table-${index}`;
          return (
            <div
              key={tableKey}
              data-block="table"
              className={classOf(block)}
              contentEditable={false}
            >
              <table className="w-full border-collapse text-[12.5px]">
                <tbody>
                  {tableGrid(table.rows).map((row) => (
                    <tr key={row.id}>
                      {row.cells.map((cell) => (
                        <td
                          key={cell.id}
                          className="border border-border/70 px-2 py-1 align-top"
                        >
                          <Runs
                            runs={cell.runs}
                            onDeleteImage={editable ? onDeleteImage : undefined}
                            canMove={editable}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        // A heading is drawn as the heading element it is: the tag carries the structure a reader
        // (or anything reading the page) uses, and it is still one direct child of the surface, so
        // the flat shape the writer reads back is unchanged.
        const Tag = (block.kind.startsWith("h") ? block.kind : "div") as
          | "div"
          | "h1"
          | "h2"
          | "h3"
          | "h4"
          | "h5"
          | "h6";
        // A nested list item is drawn one step in: the file says which level each item is on, and a
        // document whose sub-items sit at the left margin reads as one flat list. The level is not
        // part of what is compared or written - the writer keeps each paragraph's own properties -
        // so this is drawn from the read and never sent back.
        const read = doc.blocks[index];
        const level =
          block.kind === "li" && read?.kind === "paragraph" ? (read.list?.level ?? 0) : 0;
        const blockBox = blockStyle(block.kind, read?.kind === "paragraph" ? read : null);
        if (block.kind === "li") {
          // A list item is drawn one step in per its level, on top of whatever indent the file gives
          // it (a nested item at its parent's margin reads as one flat list). The marker sits at the
          // start of that box.
          const own = read?.kind === "paragraph" && read.indent?.left
            ? twipsToPx(read.indent.left)
            : 24;
          blockBox.paddingLeft = `${Math.round(own + level * 20)}px`;
        }
        return (
          <Tag
            key={`b${block.ordinal ?? index}`}
            data-block={block.kind}
            data-docx-editable={block.ordinal ?? undefined}
            data-list={block.list ?? undefined}
            data-num-id={block.numId ?? undefined}
            data-level={block.kind === "li" ? level : undefined}
            role={block.kind === "li" ? "listitem" : undefined}
            style={blockBox}
            className={classOf(block)}
            onDragOver={(event: React.DragEvent) => {
              if (!editable || block.ordinal == null) return;
              if (!event.dataTransfer.types.includes(PICTURE_DRAG)) return;
              // Without this the browser refuses the drop and the picture springs back.
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event: React.DragEvent) => {
              if (!editable || block.ordinal == null) return;
              const carried = event.dataTransfer.getData(PICTURE_DRAG);
              if (!carried) return;
              event.preventDefault();
              onMoveImage(Number(carried), block.ordinal);
            }}
          >
            {deleteButton(block.ordinal)}
            {/* An empty paragraph needs something in it, or it has no height and no place to put
                the caret. This is the blank line. */}
            {read?.kind === "paragraph" && read.runs.length > 0 ? (
              <Runs
                runs={read.runs}
                onDeleteImage={editable ? onDeleteImage : undefined}
                canMove={editable}
              />
            ) : (
              <br />
            )}
          </Tag>
        );
      })}
        </div>
      </div>
    </div>
  );
});

/** What the shell can ask of an open document. */
type DocxPreviewProps = {
  path: string;
  /**
   * Whether the pane is holding text the file does not have yet.
   *
   * The tab shows the same dot a text file gets; without this a document with unsaved typing looked
   * saved, and closing the tab did not ask.
   */
  onDirtyChange?: (dirty: boolean) => void;
};

export type DocxPreviewHandle = {
  /**
   * Takes back the last change.
   *
   * The shell's own undo shortcut (`Mod+Z`) calls this: the app's global shortcut layer handles that
   * key in the capture phase and stops it there, so a keydown listener inside the pane would never
   * hear it.
   */
  undo: () => void;
};

export const DocxPreview = forwardRef<DocxPreviewHandle, DocxPreviewProps>(
  function DocxPreview({ path, onDirtyChange }, ref) {
    const t = useT();
    // The editor's own setting: "how long is stopping typing" is one answer for the whole app.
    const autoSave = usePreferencesStore((state) => state.editorAutoSave);
    const saveDelay = usePreferencesStore(
      (state) => state.editorAutoSaveDelay,
    );
    const delayRef = useRef(
      Number.isFinite(saveDelay) ? saveDelay : SAVE_DELAY_FALLBACK_MS,
    );
    delayRef.current = Number.isFinite(saveDelay)
      ? saveDelay
      : SAVE_DELAY_FALLBACK_MS;
    /** Whether typing alone is worth a write; without it the file is written when focus leaves. */
    const autoSaveRef = useRef(autoSave);
    autoSaveRef.current = autoSave;
    const dirtyRef = useRef(false);
    /** Tell the shell once per change of state, not on every keystroke. */
    const markDirty = useCallback(
      (dirty: boolean) => {
        if (dirtyRef.current === dirty) return;
        dirtyRef.current = dirty;
        onDirtyChange?.(dirty);
      },
      [onDirtyChange],
    );
    const [state, setState] = useState<LoadState>({ kind: "loading" });
    const [save, setSave] = useState<SaveState>({ kind: "idle" });
    /** How much room the pane has, so a page wider than it can be fitted to what there is. */
    const [available, setAvailable] = useState(0);
    /** The blocks the file has, as of the last read or the last successful write. */
    const baseline = useRef<BaselineBlock[]>([]);
    const root = useRef<HTMLDivElement | null>(null);
    const bodyRef = useRef<HTMLDivElement | null>(null);
    /** The file the save state belongs to; a re-read of the same one is not a new document. */
    const openedPath = useRef(path);
    const guard = useRef<DocxGuard | null>(null);
    const timer = useRef<number | null>(null);
    const inFlight = useRef(false);
    const queued = useRef(false);
    /** Which line the caret goes back into once a re-read has replaced the DOM. */
    const caretAfter = useRef<{ position: number; offset: number } | null>(
      null,
    );
    /** Set when the file changed under us: nothing more is written until it is read again. */
    const stale = useRef(false);
    const [reloadKey, setReloadKey] = useState(0);

    // The pane's own width, watched rather than read once: the window is resized, the side panel is
    // dragged, and the tab is split, and the page has to come to scale again for each.
    //
    // It runs again when the document arrives, because the element it measures is only drawn once
    // there is a document to draw: on the first pass the pane is still the loading notice, and the
    // ref is null.
    // biome-ignore lint/correctness/useExhaustiveDependencies: the load state is the only trigger this measurement has
    useEffect(() => {
      const element = root.current;
      if (!element) return;
      const measure = () => setAvailable(element.clientWidth);
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }, [state.kind]);

    useEffect(() => {
      // `reloadKey` is read here only to make this run again: reopening a document whose file changed
      // under us is the same read, with a new key.
      void reloadKey;
      let cancelled = false;
      setState({ kind: "loading" });
      // A re-read of the same file keeps what the pane last said about saving it - a structural change
      // (Enter, a deletion) is read back, and "已保存" must not disappear just because the numbering was
      // refreshed. Opening a different file starts over.
      if (openedPath.current !== path) {
        openedPath.current = path;
        setSave({ kind: "idle" });
      }
      stale.current = false;
      native
        .readDocx(path)
        .then((document) => {
          if (cancelled) return;
          // The reader reports the file's identity, so the first save has something to check against
          // without a second round trip.
          guard.current = document.guard;
          baseline.current = blocksFromDocument(document);
          setState({ kind: "ready", document });
          // A fresh read of a file is nothing owed to it.
          markDirty(false);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          const message =
            error instanceof Error ? error.message : String(error);
          setState({ kind: "error", message });
        });
      // A slow read of a file the user has already closed must not land on the next one.
      return () => {
        cancelled = true;
      };
    }, [markDirty, path, reloadKey]);

    useEffect(
      () => () => {
        if (timer.current !== null) window.clearTimeout(timer.current);
      },
      [],
    );

    // The caret is put back after the DOM has been replaced by a re-read. `state` is the dependency
    // on purpose: it is what moves when the read lands, and the body only exists after it does.
    // biome-ignore lint/correctness/useExhaustiveDependencies: runs after a read, which is what `state` marks
    useEffect(() => {
      const caret = caretAfter.current;
      const body = bodyRef.current;
      if (caret === null || !body) return;
      caretAfter.current = null;
      body.focus();
      placeCaretAtBlock(body, caret.position, caret.offset);
    }, [state]);

    const write = useCallback(async () => {
      if (inFlight.current) {
        queued.current = true;
        return;
      }
      const current = guard.current;
      const body = bodyRef.current;
      if (!current || !body) return;
      const draft = readDraftBlocks(body);
      const before = baseline.current;
      const { edits, deleted, inserts } = alignBlocks(before, draft);
      if (edits.length === 0 && deleted.length === 0 && inserts.length === 0) {
        return;
      }
      inFlight.current = true;
      setSave({ kind: "saving" });
      // A structural change moves every ordinal after it, so the file has to be read again
      // afterwards; a pure text edit leaves the numbering alone and the caret where it is.
      const reread = needsReread(before, draft);
      try {
        guard.current = await native.writeDocx(
          path,
          edits,
          deleted,
          inserts,
          current,
        );
        // Typing can land between the snapshot and this line, and a re-read would rebuild the body
        // from the file and throw it away. What is left in the DOM is written before anything is
        // read back, up to a couple of rounds - a structural save that keeps taking new input has
        // to settle before the numbering can be trusted again.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const leftover = alignBlocks(
            adoptDraft(before, draft),
            readDraftBlocks(body),
          );
          if (
            leftover.edits.length === 0 &&
            leftover.deleted.length === 0 &&
            leftover.inserts.length === 0
          ) {
            break;
          }
          guard.current = await native.writeDocx(
            path,
            leftover.edits,
            leftover.deleted,
            leftover.inserts,
            guard.current,
          );
        }
        // The draft lines up with the writable baseline one for one here: a write that changes the
        // numbering re-reads instead of trusting this.
        baseline.current = adoptDraft(before, draft);
        markDirty(false);
        setSave({ kind: "saved" });
        if (reread) {
          // The numbering is the only reason to read back: an insert or a delete moved every
          // ordinal after it, and the DOM cannot know by how much. What the read is *not* for is
          // the page - the body is left exactly as it is. Rendering the new read would re-key every
          // block after the one that moved, and rebuilding lines that had not changed is the flash
          // and the jump the user saw on every Enter.
          const next = await native.readDocx(path);
          guard.current = next.guard;
          baseline.current = blocksFromDocument(next);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        // "磁盘" is the writer saying the file is not the one it read. Retrying would overwrite
        // whatever changed it, so the pane stops and asks for a fresh read instead.
        if (message.includes("磁盘")) {
          stale.current = true;
          setSave({ kind: "stale", message });
        } else {
          setSave({ kind: "failed", message });
        }
        return;
      } finally {
        inFlight.current = false;
      }
      if (queued.current) {
        queued.current = false;
        void write();
      }
    }, [markDirty, path]);

    const schedule = useCallback(() => {
      if (stale.current) return;
      // Autosave is the user's setting, and it is the same one the text editor reads. With it off,
      // typing waits for the pane to lose focus rather than writing behind their back.
      if (!autoSaveRef.current) return;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        void write();
      }, delayRef.current);
    }, [write]);

    /**
     * Something in the body changed.
     *
     * A structural change is written at once rather than on the debounce: the paragraph numbering
     * moved, and typing into a model whose numbering is stale is how an edit lands on the wrong
     * paragraph.
     */
    const onEdited = useCallback(() => {
      const body = bodyRef.current;
      if (!body || stale.current) return;
      const draft = readDraftBlocks(body);
      const pending =
        needsReread(baseline.current, draft) ||
        alignBlocks(baseline.current, draft).edits.length > 0;
      if (pending) markDirty(true);
      // A structural change is written at once: the paragraph numbering moved, and typing into a
      // model whose numbering is stale is how an edit lands on the wrong paragraph. Typing alone
      // waits for the delay (and for the user's own autosave setting).
      if (needsReread(baseline.current, draft)) {
        if (timer.current !== null) {
          window.clearTimeout(timer.current);
          timer.current = null;
        }
        void write();
        return;
      }
      schedule();
    }, [markDirty, schedule, write]);

    const onDelete = useCallback((ordinal: number) => {
      const body = bodyRef.current;
      // The ordinal written into the DOM is the one the file had when the body was drawn, and an
      // insert since then shifted every one after it. The paragraph is found by where it is now.
      const position = baseline.current
        .filter((block) => block.kind !== "table")
        .findIndex((block) => block.ordinal === ordinal);
      const block = body?.children[position];
      if (!body || !(block instanceof HTMLElement)) return;
      block.remove();
      normalizeBody(body);
      void write();
    }, [write]);

    /**
     * Takes one picture out of the file.
     *
     * A pending save is settled first, so the picture is named against the numbering it was drawn
     * with: a save that inserted a paragraph moves every ordinal after it.
     */
    const onDeleteImage = useCallback(
      async (drawing: number) => {
        if (timer.current !== null) {
          window.clearTimeout(timer.current);
          timer.current = null;
        }
        const current = guard.current;
        if (!current) return;
        setSave({ kind: "saving" });
        try {
          guard.current = await native.deleteDocxImage(path, drawing, current);
          // The picture is gone from the file, so the page is read again rather than patched: the
          // runs of that paragraph are no longer what the DOM holds.
          setReloadKey((key) => key + 1);
          setSave({ kind: "saved" });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("磁盘")) {
            stale.current = true;
            setSave({ kind: "stale", message });
          } else {
            setSave({ kind: "failed", message });
          }
        }
      },
      [path],
    );

    /**
     * Puts a picture at the end of another paragraph.
     *
     * A pending save is settled first, so the picture and the paragraph are named against the
     * numbering they were drawn with: a save that inserted a paragraph moves every ordinal after it.
     */
    const onMoveImage = useCallback(
      async (drawing: number, to: number) => {
        if (timer.current !== null) {
          window.clearTimeout(timer.current);
          timer.current = null;
        }
        const current = guard.current;
        if (!current) return;
        setSave({ kind: "saving" });
        try {
          guard.current = await native.moveDocxImage(path, drawing, to, current);
          // The picture is in another paragraph now, so the page is read again rather than patched.
          setReloadKey((key) => key + 1);
          setSave({ kind: "saved" });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("磁盘")) {
            stale.current = true;
            setSave({ kind: "stale", message });
          } else {
            setSave({ kind: "failed", message });
          }
        }
      },
      [path],
    );

    /**
     * Takes back the last change that reached the file.
     *
     * A pending save is cancelled first: it would land straight after the undo and put the change back.
     */
    const undoLast = useCallback(async () => {
      const current = guard.current;
      if (!current || inFlight.current) return;
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      inFlight.current = true;
      setSave({ kind: "saving" });
      try {
        guard.current = await native.undoDocx(path, current);
        setSave({ kind: "saved" });
        // The part on disk is a different one now, so what is drawn has to come from it.
        setReloadKey((key) => key + 1);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        setSave(
          message.includes("磁盘")
            ? { kind: "stale", message }
            : { kind: "failed", message },
        );
      } finally {
        inFlight.current = false;
      }
    }, [path]);

    /**
     * Ctrl+Z, split by what there is to undo.
     *
     * Typing that has not been written yet is dropped by reading the file again: the pane keeps no
     * history of its own, and the file is the last state the user can actually see. Once everything is
     * on disk there is nothing pending to drop, so the last change is taken back out of the file.
     */
    const undo = useCallback(() => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      const body = bodyRef.current;
      const pending =
        body !== null &&
        (() => {
          const { edits, deleted, inserts } = alignBlocks(
            baseline.current,
            readDraftBlocks(body),
          );
          return edits.length + deleted.length + inserts.length > 0;
        })();
      if (pending) {
        setReloadKey((key) => key + 1);
        return;
      }
      void undoLast();
    }, [undoLast]);

    useImperativeHandle(ref, () => ({ undo }), [undo]);

    const retry = useCallback(() => {
      stale.current = false;
      setSave({ kind: "idle" });
      void write();
    }, [write]);

    const reread = useCallback(() => {
      setReloadKey((key) => key + 1);
    }, []);

    if (state.kind === "loading") {
      return (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          {t("editor.docx.loading")}
        </div>
      );
    }

    if (state.kind === "error") {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
          <div className="text-sm text-destructive">
            {t("editor.docx.failed")}
          </div>
          <div className="text-xs text-muted-foreground">{state.message}</div>
        </div>
      );
    }

    const { truncated, editable } = state.document;

    return (
      // The same scroll class the rendered Markdown wears: a document read top to bottom gets the thin
      // bar the shell hides everywhere else.
      <div
        ref={root}
        data-docx-preview=""
        // The save state is readable here rather than drawn: a document does not need a banner
        // saying 已保存 - the tab's dot carries that, exactly as it does for a text file. A failure
        // is the one thing that still speaks up (below).
        data-docx-save={save.kind}
        className="verta-doc-scroll h-full overflow-auto"
      >
        {save.kind === "failed" || save.kind === "stale" ? (
          <div className="sticky top-0 z-10 flex items-center gap-2 bg-destructive/10 px-3 py-1 text-[10.5px] text-destructive">
            <span className="min-w-0 flex-1 truncate">
              {save.kind === "stale"
                ? t("editor.docx.conflict")
                : t("editor.docx.saveFailed", { error: save.message })}
            </span>
            <button
              type="button"
              onClick={save.kind === "stale" ? reread : retry}
              className="shrink-0 rounded border border-current/40 px-1.5 py-0.5"
            >
              {t(
                save.kind === "stale"
                  ? "editor.docx.reread"
                  : "editor.docx.retry",
              )}
            </button>
          </div>
        ) : null}
        <DocxBody
          key={reloadKey}
          doc={state.document}
          editable={editable}
          bodyRef={bodyRef}
          available={available}
          onEdited={onEdited}
          onDelete={onDelete}
          onDeleteImage={onDeleteImage}
          onMoveImage={onMoveImage}
        />
        {truncated ? (
          <p className="mx-auto max-w-[46rem] border-t border-border/60 px-8 pt-2 text-[11.5px] text-muted-foreground">
            {t("editor.docx.truncated")}
          </p>
        ) : null}
        {!editable ? (
          <p className="mx-auto max-w-[46rem] px-8 pb-4 text-[11.5px] text-muted-foreground">
            {t("editor.docx.readOnly")}
          </p>
        ) : null}
      </div>
    );
  },
);

/** The parts of a read the pane draws, for the tests that pin the routing. */
export type { DocxBlock };
