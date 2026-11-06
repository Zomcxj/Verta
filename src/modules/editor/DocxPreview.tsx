import {
  native,
  type DocxBlock,
  type DocxDocument,
  type DocxGuard,
  type DocxRun,
} from "@/lib/native";
import { useT } from "@/modules/i18n";
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
  rows: string[][],
): { id: number; cells: { id: number; text: string }[] }[] {
  return rows.map((row, rowIndex) => ({
    id: rowIndex,
    cells: row.map((text, cellIndex) => ({ id: cellIndex, text })),
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
const SAVE_DELAY_MS = 600;

/** A list where order is the only identity there is: each entry gets the position as its id. */
function numbered<T>(items: T[]): { id: number; item: T }[] {
  return items.map((item, id) => ({ id, item }));
}

function Runs({ runs }: { runs: DocxRun[] }) {
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
        >
          {run.text}
        </span>
      ))}
    </>
  );
}

const BLOCK_CLASS: Record<string, string> = {
  p: "group/block relative my-1.5 first:mt-0",
  li: "group/block relative my-1 pl-6",
  table: "my-3 overflow-x-auto",
};

function classOf(block: BaselineBlock): string {
  if (block.kind === "table") return BLOCK_CLASS.table;
  if (block.kind === "li") return BLOCK_CLASS.li;
  if (block.kind === "p") return BLOCK_CLASS.p;
  const level = Number.parseInt(block.kind.slice(1), 10);
  return `group/block relative mt-4 mb-1.5 first:mt-0 ${HEADING_CLASS[level - 1] ?? ""}`;
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
  onEdited,
  onDelete,
}: {
  doc: DocxDocument;
  editable: boolean;
  bodyRef: React.RefObject<HTMLDivElement | null>;
  onEdited: () => void;
  onDelete: (ordinal: number) => void;
}) {
  const t = useT();
  const blocks = useMemo(() => blocksFromDocument(doc), [doc]);

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

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: this is the document itself, not a control: the editable surface is what the browser gives a caret and an input method to, and its handlers exist to keep the DOM readable back
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
      className="mx-auto max-w-[46rem] px-8 py-6 text-[13px] leading-relaxed text-foreground outline-none"
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
                          {cell.text}
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
        return (
          <Tag
            key={`b${block.ordinal ?? index}`}
            data-block={block.kind}
            data-docx-editable={block.ordinal ?? undefined}
            data-list={block.list ?? undefined}
            data-num-id={block.numId ?? undefined}
            data-level={block.kind === "li" ? level : undefined}
            role={block.kind === "li" ? "listitem" : undefined}
            style={level > 0 ? { paddingLeft: `${1.5 + level * 1.25}rem` } : undefined}
            className={classOf(block)}
          >
            {deleteButton(block.ordinal)}
            <Runs
              runs={
                doc.blocks[index]?.kind === "paragraph"
                  ? doc.blocks[index].runs
                  : []
              }
            />
          </Tag>
        );
      })}
    </div>
  );
});

/** What the shell can ask of an open document. */
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

export const DocxPreview = forwardRef<DocxPreviewHandle, { path: string }>(
  function DocxPreview({ path }, ref) {
    const t = useT();
    const [state, setState] = useState<LoadState>({ kind: "loading" });
    const [save, setSave] = useState<SaveState>({ kind: "idle" });
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
    }, [path, reloadKey]);

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
        setSave({ kind: "saved" });
        if (reread) {
          caretAfter.current = caretInBody(body);
          setReloadKey((key) => key + 1);
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
    }, [path]);

    const schedule = useCallback(() => {
      if (stale.current) return;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        void write();
      }, SAVE_DELAY_MS);
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
      if (needsReread(baseline.current, readDraftBlocks(body))) {
        if (timer.current !== null) {
          window.clearTimeout(timer.current);
          timer.current = null;
        }
        void write();
        return;
      }
      schedule();
    }, [schedule, write]);

    const onDelete = useCallback(
      (ordinal: number) => {
        const body = bodyRef.current;
        const block = body?.querySelector(`[data-docx-editable="${ordinal}"]`);
        if (!body || !block) return;
        block.remove();
        normalizeBody(body);
        void write();
      },
      [write],
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
        className="verta-doc-scroll h-full overflow-auto"
      >
        {save.kind === "saving" || save.kind === "saved" ? (
          <div
            data-docx-save={save.kind}
            className="sticky top-0 z-10 flex justify-end bg-background/80 px-3 py-0.5 text-[10.5px] text-muted-foreground"
          >
            {t(
              save.kind === "saving"
                ? "editor.docx.saving"
                : "editor.docx.saved",
            )}
          </div>
        ) : null}
        {save.kind === "failed" || save.kind === "stale" ? (
          <div
            data-docx-save={save.kind}
            className="sticky top-0 z-10 flex items-center gap-2 bg-destructive/10 px-3 py-1 text-[10.5px] text-destructive"
          >
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
          onEdited={onEdited}
          onDelete={onDelete}
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
