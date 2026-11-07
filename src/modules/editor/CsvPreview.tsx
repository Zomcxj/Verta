import type { DocxGuard } from "@/lib/native";
import { invoke } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/modules/i18n";
import { envForPath } from "@/modules/workspace";
import { type ColumnWidths, effectiveWidths } from "./lib/columnResize";
import { useColumnDrag } from "./lib/useColumnDrag";
import { columnOffsets } from "./lib/xlsxGrid";

export type CsvDocument = {
  /** The character the fields are separated by, as it is in the file. */
  delimiter: string;
  rows: string[][];
  columns: number;
  truncated: boolean;
  /** The file's identity at the read, so a cell can check it is still writing into that file. */
  guard: DocxGuard;
};

/**
 * How wide each column is, from what is in it.
 *
 * A grid of equal columns wastes the widest column's space and cuts the narrowest one's text off;
 * measuring the first rows is what a spreadsheet does, and it costs nothing.
 */
export function columnWidths(rows: string[][], columns: number): number[] {
  const SAMPLE = 200;
  const MIN = 72;
  const MAX = 320;
  const widths: number[] = [];
  for (let column = 0; column < columns; column += 1) {
    let widest = MIN;
    for (let row = 0; row < Math.min(rows.length, SAMPLE); row += 1) {
      // 7px a character is about what 12px Calibri averages, which is enough for a column to be
      // readable without measuring every cell in the browser.
      const wanted = 24 + (rows[row][column] ?? "").length * 7;
      widest = Math.max(widest, Math.min(MAX, wanted));
    }
    widths.push(widest);
  }
  return widths;
}

/** What a user sees for a delimiter, since a tab has no appearance. */
export function delimiterName(delimiter: string): string {
  if (delimiter === "\t") return "Tab";
  return delimiter;
}

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 28;

/**
 * A `.csv` as a table.
 *
 * Read-only, and it says what it read: the delimiter, the size, and whether the file was longer
 * than the pane draws. Nothing here writes - the source stop is where a `.csv` is edited.
 */
export function CsvPreview({ path }: { path: string }) {
  const t = useT();
  const scroll = useRef<HTMLDivElement | null>(null);
  const { document, failed, rows, error, writeCell } = useCsv(path);
  const columns = document?.columns ?? 0;
  const fileWidths = useMemo(() => columnWidths(rows, columns), [rows, columns]);
  // A width the reader dragged, laid over what the file suggests. Nothing is written back: a
  // `.csv` keeps its bytes, so the widths come back on reopening.
  const [dragged, setDragged] = useState<ColumnWidths>(new Map());
  const widths = useMemo(
    () => effectiveWidths(columns, fileWidths, dragged),
    [columns, fileWidths, dragged],
  );
  const offsets = useMemo(() => columnOffsets(widths), [widths]);
  const width = widths.reduce((total, column) => total + column, 0);
  const headerRow = useRef<HTMLDivElement | null>(null);
  const drag = useColumnDrag(headerRow, offsets, widths, setDragged);
  // A different file starts from its own widths again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: path is the only trigger this reset has
  useEffect(() => {
    setDragged(new Map());
  }, [path]);
  const virtualizer = useVirtualizer({
    count: Math.max(rows.length - 1, 0),
    getScrollElement: () => scroll.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  if (failed) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
        {t("editor.csv.unreadable")}
      </div>
    );
  }
  if (!document) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t("editor.csv.reading")}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t("editor.csv.empty")}
      </div>
    );
  }

  const header = rows[0];
  const body = rows.slice(1);
  /**
   * One cell.
   *
   * Editable in place: a spreadsheet row of numbers that cannot be corrected is not a reader, it is
   * a picture of one. The edit goes to the file as soon as the cell is left, and only that field's
   * bytes are replaced - the rest of the file, quoting and line endings included, is untouched.
   */
  const cell = (row: number, column: number, text: string, bold: boolean) => (
    // biome-ignore lint/a11y/noStaticElementInteractions: a cell of a table is edited like a cell of a spreadsheet, not by a control with a label
    <div
      key={column}
      data-csv-cell={row}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      style={{ width: widths[column] ?? 72, minWidth: widths[column] ?? 72 }}
      className={[
        "shrink-0 truncate border-r border-border/50 px-1.5 py-0.5 text-foreground outline-none",
        // A cell being edited is ringed rather than filled: the value is what should stand out.
        "focus:ring-1 focus:ring-inset focus:ring-ring/40",
        bold ? "font-semibold" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      title={text}
      onBlur={(event) => {
        const next = (event.currentTarget.textContent ?? "").trim();
        if (next !== text) void writeCell(row, column, next);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          // Enter commits rather than opening a second line: the table draws one line a row.
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.currentTarget.textContent = text;
          event.currentTarget.blur();
        }
      }}
    >
      {text}
    </div>
  );

  return (
    <div data-csv-preview="" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-2.5 py-1 text-[10.5px] text-muted-foreground">
        <span>
          {t("editor.csv.summary", { rows: body.length, columns })}
        </span>
        <span>
          {t("editor.csv.delimiter", { delimiter: delimiterName(document.delimiter) })}
        </span>
        {document.truncated ? <span>{t("editor.csv.truncated")}</span> : null}
        {error ? <span className="text-destructive">{error}</span> : null}
      </div>
      <div ref={scroll} className="verta-doc-scroll min-h-0 flex-1 overflow-auto">
        <div style={{ width }} className="min-w-full">
          <div
            ref={headerRow}
            onPointerDown={drag.onPointerDown}
            className="sticky top-0 z-10 flex bg-background"
            style={{ height: HEADER_HEIGHT, cursor: drag.dragging === null ? undefined : "col-resize" }}
          >
            {header.map((text, column) => cell(0, column, text, true))}
          </div>
          <div style={{ height: virtualizer.getTotalSize() }} className="relative">
            {virtualizer.getVirtualItems().map((item) => {
              const row = body[item.index] ?? [];
              return (
                <div
                  key={item.key}
                  data-csv-row={item.index}
                  className="absolute left-0 flex border-b border-border/30"
                  style={{ top: item.start, height: item.size, width }}
                >
                  {Array.from({ length: columns }, (_, column) =>
                    cell(item.index + 1, column, row[column] ?? "", false),
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A `.csv` is read when its tab opens; a cell edit is written straight through. */
function useCsv(path: string): {
  document: CsvDocument | null;
  failed: boolean;
  rows: string[][];
  error: string | null;
  writeCell: (row: number, column: number, text: string) => Promise<void>;
} {
  const [state, setState] = useState<{
    document: CsvDocument | null;
    failed: boolean;
  }>({ document: null, failed: false });
  const [rows, setRows] = useState<string[][]>([]);
  const [error, setError] = useState<string | null>(null);
  const guard = useRef<DocxGuard | null>(null);
  /**
   * The write in flight, and the cells waiting behind it.
   *
   * The guard is the file's identity at the moment it was written, so it only moves when a write
   * comes back. Two cells edited faster than one round trip would both send the identity the file
   * had *before* the first one, and the second would be refused as a file changed underneath it -
   * measured as an edit that never reached the file. The writes are therefore queued: each waits
   * for the one before it and takes the identity that one brought back.
   */
  const queue = useRef<Promise<void>>(Promise.resolve());
  /**
   * The cells edited since the read, so a reply that is stale for the file still shows on screen.
   *
   * A write that fails leaves the pane showing what the file holds; a cell edited after it must not
   * be rolled back to that. Every edit is recorded here as it is queued, and the file's answer is
   * laid under them.
   */
  const edited = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    setState({ document: null, failed: false });
    setRows([]);
    setError(null);
    // A new file is a new queue and a new set of edits.
    queue.current = Promise.resolve();
    edited.current = new Map();
    invoke<CsvDocument>("fs_read_csv", { path, workspace: envForPath(path) })
      .then((document) => {
        if (cancelled) return;
        guard.current = document.guard;
        // The file as it was read, with the cells edited since laid over it: a reply that arrives
        // after the user has typed on is the file's truth, not the screen's.
        const rows = document.rows.map((line) => [...line]);
        for (const [key, text] of edited.current) {
          const [row, column] = key.split(":").map(Number);
          if (!rows[row]) rows[row] = [];
          rows[row][column] = text;
        }
        setRows(rows);
        setState({ document, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ document: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const writeCell = useCallback(
    async (row: number, column: number, text: string) => {
      const run = queue.current.then(async () => {
        const current = guard.current;
        if (!current) return;
        // The cell shows what was typed as soon as it is typed: a queued edit is not a lost one.
        edited.current.set(`${row}:${column}`, text);
        setRows((previous) => {
          const next = previous.map((line) => [...line]);
          if (!next[row]) next[row] = [];
          next[row][column] = text;
          return next;
        });
        try {
          guard.current = await invoke<DocxGuard>("fs_write_csv_cell", {
            path,
            row,
            column,
            text,
            guard: current,
            workspace: envForPath(path),
          });
          setError(null);
        } catch (failure: unknown) {
          // The pane keeps showing what it read, and says why the write did not land.
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      });
      // The next cell waits for this one however this one turned out.
      queue.current = run.catch(() => undefined);
      await run;
    },
    [path],
  );

  return { ...state, rows, error, writeCell };
}
