import {
  native,
  type DocxBlock,
  type DocxDocument,
  type DocxEdit,
  type DocxGuard,
  type DocxInsert,
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
  useRef,
  useState,
} from "react";

/**
 * A Word document, drawn from the blocks the Rust side read out of it - and editable in place.
 *
 * A `.docx` is a ZIP, so the editor could only call it a binary file. The archive is opened in Rust
 * (see `src-tauri/src/modules/docx.rs`) and arrives here as paragraphs, lists and tables: no HTML
 * passthrough, so nothing in the document can inject anything into the window, and no parser in this
 * bundle.
 *
 * Editing is by paragraph. Typing replaces a paragraph's text - it goes into that paragraph's first
 * run, and the rest are emptied, so a paragraph edited here loses any emphasis inside it, while every
 * paragraph that is not touched keeps exactly what Word wrote. Saving happens on its own shortly after
 * typing stops, back into the same file, because a document that has to be saved somewhere else is one
 * the user has to remember to save.
 *
 * What the reader does not carry - images, text boxes, footnotes - is simply not drawn; a document
 * whose meaning is in a picture will read as its captions.
 *
 * Everything below numbers what it draws as it draws it. A document's blocks have no identity beyond
 * their position (two identical paragraphs are normal), so a position-derived id, assigned once per
 * read, is what gives React a stable key for them.
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

/** One list item, numbered within its list. */
export type DocxListItem = {
  id: number;
  index: number;
  level: number;
  runs: DocxRun[];
};

export type DocxGroup =
  | { kind: "block"; id: number; block: DocxBlock }
  | { kind: "list"; id: number; ordered: boolean; items: DocxListItem[] };

/**
 * Consecutive list items are one list: Word marks numbering per paragraph, so the paragraphs are
 * where the information is and the element is what makes them read as a list.
 */
export function groupBlocks(blocks: DocxBlock[]): DocxGroup[] {
  const groups: DocxGroup[] = [];
  for (const [index, block] of blocks.entries()) {
    const list = block.kind === "paragraph" ? block.list : null;
    const runs = block.kind === "paragraph" ? block.runs : [];
    const paragraphIndex = block.kind === "paragraph" ? block.index : -1;
    if (!list) {
      groups.push({ kind: "block", id: index, block });
      continue;
    }
    const last = groups[groups.length - 1];
    if (last?.kind === "list") {
      last.items.push({
        id: index,
        index: paragraphIndex,
        level: list.level,
        runs,
      });
    } else {
      groups.push({
        kind: "list",
        id: index,
        ordered: list.ordered,
        items: [{ id: index, index: paragraphIndex, level: list.level, runs }],
      });
    }
  }
  return groups;
}

/** The table's rows and cells, numbered so each has a key of its own. */
export function tableGrid(
  rows: string[][],
): { id: number; cells: { id: number; text: string }[] }[] {
  return rows.map((row, rowIndex) => ({
    id: rowIndex,
    cells: row.map((text, cellIndex) => ({ id: cellIndex, text })),
  }));
}

/**
 * Whether this block can be edited in place.
 *
 * Only a paragraph with text in it: a table is drawn from joined cell strings, which cannot be mapped
 * back to its cells, and a paragraph whose runs are empty has no text node for the writer to put
 * anything into. A document read only in part is read-only for a different reason - saving from it
 * would drop everything past the cut.
 */
export function isEditableBlock(
  block: DocxBlock,
  documentEditable: boolean,
): boolean {
  return (
    documentEditable && block.kind === "paragraph" && block.runs.length > 0
  );
}

/**
 * What to send: the paragraphs that were typed in, the ones that were deleted, and the ones to add.
 *
 * A paragraph that was typed in and then deleted is not sent as an edit - the deletion wins.
 */
export function pendingEdits(
  texts: Map<number, string>,
  deleted: Set<number>,
  inserts: DocxInsert[],
): { edits: DocxEdit[]; deleted: number[]; inserts: DocxInsert[] } {
  return {
    edits: [...texts.entries()]
      .filter(([index]) => !deleted.has(index))
      .sort((left, right) => left[0] - right[0])
      .map(([index, text]) => ({ index, text })),
    deleted: [...deleted].sort((left, right) => left - right),
    // `after: null` is the top of the body, which is in front of paragraph 0 - not equal to it.
    inserts: [...inserts].sort(
      (left, right) => (left.after ?? -1) - (right.after ?? -1),
    ),
  };
}

/**
 * Where the caret sits inside an editable element, as a character offset into its text.
 *
 * Pressing Enter splits the paragraph at the caret, so the offset is the whole question: without a
 * selection the caret is taken to be at the end, which is what pressing Enter after typing looks like.
 */
export function caretOffset(element: HTMLElement): number {
  const text = element.textContent ?? "";
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return text.length;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) return text.length;
  const before = range.cloneRange();
  before.selectNodeContents(element);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

/** A paragraph's whole text, which is what an edit replaces. */
function textOf(runs: DocxRun[]): string {
  return runs.map((run) => run.text).join("");
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

/**
 * A paragraph's text, editable in place.
 *
 * The runs are drawn as they were read, so a paragraph with a bold word in it still shows that word
 * bold until the paragraph is edited - the emphasis is only lost by an edit, which merges the runs.
 *
 * Deliberately uncontrolled: React re-renders this pane whenever the save status changes, and a
 * re-render would put the original runs back over what the user just typed. So the component skips
 * every re-render whose document text is unchanged, and the typed text lives in the DOM until it is
 * written to the file.
 */
const EditableText = memo(
  function EditableText({
    runs,
    index,
    onEdit,
    onSplit,
  }: {
    runs: DocxRun[];
    index: number;
    onEdit: (index: number, text: string) => void;
    onSplit: (index: number, before: string, after: string) => void;
  }) {
    return (
      // `plaintext-only`: a paste arrives as text, not as whatever markup the clipboard held. Enter is
      // swallowed because a new paragraph is not something this pane can write. No `role` and no
      // `tabIndex`: a contenteditable element is already focusable and announced as editable, and a
      // role here would only claim the paragraph is a form field.
      // biome-ignore lint/a11y/noStaticElementInteractions: this is a paragraph of a document, not a form control - a textarea cannot flow inside the heading or list item it belongs to
      <span
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        spellCheck={false}
        data-docx-editable={index}
        onInput={(event) =>
          onEdit(index, event.currentTarget.textContent ?? "")
        }
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey) return;
          // Enter adds a paragraph, the way it does in Word: what is after the caret becomes the next
          // paragraph, carrying this one's style. Shift+Enter is left alone for a line break.
          event.preventDefault();
          const typed = event.currentTarget.textContent ?? "";
          const at = caretOffset(event.currentTarget);
          onSplit(index, typed.slice(0, at), typed.slice(at));
        }}
        className="outline-none focus-visible:rounded-sm focus-visible:bg-accent/40"
      >
        <Runs runs={runs} />
      </span>
    );
  },
  // The document's own text is what decides whether this needs redrawing: `runs` is a fresh array on
  // every render of the pane, and comparing it by identity would wipe what the user is typing.
  (prev, next) =>
    prev.index === next.index &&
    prev.onEdit === next.onEdit &&
    prev.onSplit === next.onSplit &&
    textOf(prev.runs) === textOf(next.runs),
);

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
    /** Paragraphs taken out of the document; a state so the block disappears as it is removed. */
    const [removed, setRemoved] = useState<ReadonlySet<number>>(new Set());
    /** What was typed, by paragraph ordinal. A ref: the DOM already shows it, so it needs no re-render. */
    const texts = useRef(new Map<number, string>());
    const deleted = useRef(new Set<number>());
    /** Paragraphs to add, by the paragraph they follow. */
    const inserts = useRef<DocxInsert[]>([]);
    /** Where the caret belongs once a split has been written and read back. */
    const focusAfter = useRef<number | null>(null);
    const root = useRef<HTMLDivElement | null>(null);
    /** The file the save state belongs to; a re-read of the same one is not a new document. */
    const openedPath = useRef(path);
    const guard = useRef<DocxGuard | null>(null);
    const timer = useRef<number | null>(null);
    const inFlight = useRef(false);
    const queued = useRef(false);
    /** Set when the file changed under us: nothing more is written until it is read again. */
    const stale = useRef(false);
    const [reloadKey, setReloadKey] = useState(0);

    useEffect(() => {
      // `reloadKey` is read here only to make this run again: reopening a document whose file changed
      // under us is the same read, with a new key.
      void reloadKey;
      let cancelled = false;
      setState({ kind: "loading" });
      texts.current = new Map();
      deleted.current = new Set();
      inserts.current = [];
      setRemoved(new Set());
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

    const write = useCallback(async () => {
      if (inFlight.current) {
        queued.current = true;
        return;
      }
      const current = guard.current;
      if (!current) return;
      inFlight.current = true;
      setSave({ kind: "saving" });
      // A structural change moves every ordinal after it, so the file has to be read again afterwards;
      // a pure text edit leaves the numbering alone and the caret where it is.
      const structural = deleted.current.size > 0 || inserts.current.length > 0;
      try {
        const {
          edits,
          deleted: gone,
          inserts: added,
        } = pendingEdits(texts.current, deleted.current, inserts.current);
        const next = await native.writeDocx(path, edits, gone, added, current);
        guard.current = next;
        setSave({ kind: "saved" });
        if (structural) {
          setReloadKey((key) => key + 1);
        } else {
          // The file has these now. Keeping them would make the pane look dirty for ever, and "is
          // anything unsaved" is the question Ctrl+Z asks.
          texts.current.clear();
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

    const onEdit = useCallback(
      (index: number, text: string) => {
        texts.current.set(index, text);
        schedule();
      },
      [schedule],
    );

    const onDelete = useCallback(
      (index: number) => {
        texts.current.delete(index);
        deleted.current.add(index);
        setRemoved((current) => new Set(current).add(index));
        schedule();
      },
      [schedule],
    );

    /**
     * Enter: what is after the caret becomes the next paragraph.
     *
     * Written straight away rather than on the debounce, because the paragraph count changes: the
     * re-read that follows is what puts the ordinals back in step with the file, and typing into a model
     * whose numbering has moved on is how an edit lands on the wrong paragraph.
     */
    const onSplit = useCallback(
      (index: number, before: string, after: string) => {
        texts.current.set(index, before);
        inserts.current.push({ after: index, text: after });
        focusAfter.current = index + 1;
        if (timer.current !== null) {
          window.clearTimeout(timer.current);
          timer.current = null;
        }
        void write();
      },
      [write],
    );

    useEffect(() => {
      const index = focusAfter.current;
      if (index === null || state.kind !== "ready") return;
      focusAfter.current = null;
      const node = root.current?.querySelector<HTMLElement>(
        `[data-docx-editable="${index}"]`,
      );
      if (!node) return;
      node.focus();
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }, [state]);

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
      const unsaved =
        texts.current.size > 0 ||
        deleted.current.size > 0 ||
        inserts.current.length > 0;
      if (unsaved) {
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

    const { blocks, truncated, editable } = state.document;
    if (blocks.length === 0) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
          {t("editor.docx.empty")}
        </div>
      );
    }

    const deleteButton = (index: number) =>
      editable ? (
        <button
          type="button"
          data-docx-delete={index}
          title={t("editor.docx.deleteParagraph")}
          aria-label={t("editor.docx.deleteParagraph")}
          onClick={() => onDelete(index)}
          className="absolute -left-5 top-1 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/block:opacity-60"
        >
          {/* An icon rather than a "×": the character would be part of the paragraph's own text, and
            copying the document would carry it along. */}
          <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
        </button>
      ) : null;

    const body = (index: number, runs: DocxRun[]) =>
      isEditableBlock(
        { kind: "paragraph", index, heading: null, list: null, runs },
        editable,
      ) ? (
        <EditableText
          runs={runs}
          index={index}
          onEdit={onEdit}
          onSplit={onSplit}
        />
      ) : (
        <Runs runs={runs} />
      );

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
        <div className="mx-auto max-w-[46rem] px-8 py-6 text-[13px] leading-relaxed text-foreground">
          {groupBlocks(blocks).map((group) => {
            if (group.kind === "list") {
              const List = group.ordered ? "ol" : "ul";
              const visible = group.items.filter(
                (item) => !removed.has(item.index),
              );
              if (visible.length === 0) return null;
              return (
                <List
                  key={group.id}
                  className={[
                    "my-1.5 space-y-0.5 pl-5",
                    group.ordered ? "list-decimal" : "list-disc",
                  ].join(" ")}
                >
                  {visible.map((item) => (
                    <li
                      key={item.id}
                      style={
                        item.level > 0
                          ? { marginLeft: `${item.level * 1.1}rem` }
                          : undefined
                      }
                      className="group/block relative"
                    >
                      {deleteButton(item.index)}
                      {body(item.index, item.runs)}
                    </li>
                  ))}
                </List>
              );
            }
            const block = group.block;
            if (block.kind === "table") {
              return (
                <div key={group.id} className="my-3 overflow-x-auto">
                  <table className="w-full border-collapse text-[12.5px]">
                    <tbody>
                      {tableGrid(block.rows).map((row) => (
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
            if (removed.has(block.index)) return null;
            if (block.heading) {
              const Heading = `h${block.heading}` as
                | "h1"
                | "h2"
                | "h3"
                | "h4"
                | "h5"
                | "h6";
              return (
                <Heading
                  key={group.id}
                  className={`group/block relative mt-4 mb-1.5 first:mt-0 ${HEADING_CLASS[block.heading - 1]}`}
                >
                  {deleteButton(block.index)}
                  {body(block.index, block.runs)}
                </Heading>
              );
            }
            return (
              <p
                key={group.id}
                className="group/block relative my-1.5 first:mt-0"
              >
                {deleteButton(block.index)}
                {body(block.index, block.runs)}
              </p>
            );
          })}

          {truncated ? (
            <p className="mt-4 border-t border-border/60 pt-2 text-[11.5px] text-muted-foreground">
              {t("editor.docx.truncated")}
            </p>
          ) : null}
          {!editable ? (
            <p className="mt-2 text-[11.5px] text-muted-foreground">
              {t("editor.docx.readOnly")}
            </p>
          ) : null}
        </div>
      </div>
    );
  },
);
