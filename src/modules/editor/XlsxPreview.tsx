import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type XlsxSheet, type XlsxWorkbook, native } from "@/lib/native";
import { useT } from "@/modules/i18n";
import { type ColumnWidths, effectiveWidths } from "./lib/columnResize";
import { useColumnDrag } from "./lib/useColumnDrag";
import {
  cellJustify,
  columnLabel,
  columnOffsets,
  columnWidths,
  draws,
  mergeCells,
  total,
  windowOf,
} from "./lib/xlsxGrid";

/** The width a column gets when the file states none. */
const DEFAULT_COLUMN_WIDTH = 96;
/** The row height a row gets when the file states none. */
const DEFAULT_ROW_HEIGHT = 24;
/** The column headings are a little shorter than a row. */
const HEADER_HEIGHT = 22;
/** Columns and rows either side of the viewport, so a scroll does not arrive at an empty strip. */
const COLUMN_OVERSCAN = 2;
const ROW_OVERSCAN = 8;

/**
 * A `.xlsx` as the grid it holds.
 *
 * Read-only, and it says what it read: which sheet, how big, and whether the sheet was longer than
 * the pane draws. The sheets are read one at a time, because a workbook of fifty sheets read whole
 * is a payload of tens of megabytes for the one tab the user is looking at.
 */
export function XlsxPreview({ path }: { path: string }) {
  const t = useT();
  const scroll = useRef<HTMLDivElement | null>(null);
  const [workbook, setWorkbook] = useState<XlsxWorkbook | null>(null);
  const [failed, setFailed] = useState(false);
  const [sheet, setSheet] = useState<XlsxSheet | null>(null);
  const [sheetFailed, setSheetFailed] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  // The sheet list, once per file.
  useEffect(() => {
    let cancelled = false;
    setWorkbook(null);
    setFailed(false);
    setSheet(null);
    setSheetFailed(false);
    setActive(null);
    native.readXlsx(path)
      .then((read) => {
        if (cancelled) return;
        setWorkbook(read);
        setActive(read.sheets[0]?.name ?? null);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  // The sheet the tab names, when the tab changes or the file is a new one.
  useEffect(() => {
    if (active === null) return;
    let cancelled = false;
    setSheet(null);
    setSheetFailed(false);
    native.readXlsxSheet(path, active)
      .then((read) => {
        if (!cancelled) setSheet(read);
      })
      .catch(() => {
        if (!cancelled) setSheetFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path, active]);

  const rowCount = sheet?.rowCount ?? 0;
  const columns = sheet?.columns ?? 0;
  const fileWidths = useMemo(
    () => columnWidths(columns, sheet?.columnSizes ?? [], DEFAULT_COLUMN_WIDTH),
    [columns, sheet],
  );
  // A width the reader dragged, laid over the one the workbook states. Nothing is written back:
  // the sheet keeps its own `<col>` elements, so the widths come back on reopening.
  const [dragged, setDragged] = useState<ColumnWidths>(new Map());
  const widths = useMemo(
    () => effectiveWidths(columns, fileWidths, dragged),
    [columns, fileWidths, dragged],
  );
  const offsets = useMemo(() => columnOffsets(widths), [widths]);
  const headingStrip = useRef<HTMLDivElement | null>(null);
  const drag = useColumnDrag(headingStrip, offsets, widths, setDragged);
  const gridWidth = useMemo(() => total(widths), [widths]);
  const merges = useMemo(() => mergeCells(sheet?.merges ?? []), [sheet]);

  // Row heights by index, and the rows by index: a cell asks for its row on every paint, so it
  // cannot be a walk of the list each time.
  const { heights, rowsByIndex } = useMemo(() => {
    const stated = new Map<number, number>();
    for (const row of sheet?.rowHeights ?? []) stated.set(row.index, row.size);
    const byIndex = new Map<number, XlsxSheet["rows"][number]>();
    for (const row of sheet?.rows ?? []) byIndex.set(row.index, row);
    return { heights: stated, rowsByIndex: byIndex };
  }, [sheet]);

  const frozenRows = Math.min(sheet?.frozenRows ?? 0, rowCount);
  const frozenColumns = Math.min(sheet?.frozenColumns ?? 0, columns);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scroll.current,
    estimateSize: (index) => heights.get(index) ?? DEFAULT_ROW_HEIGHT,
    overscan: ROW_OVERSCAN,
  });

  /** Keeps the column window, the frozen cells and the pinned strips in step with the scroll. */
  const onScroll = useCallback(() => {
    const element = scroll.current;
    if (!element) return;
    setScrollLeft(element.scrollLeft);
    setScrollTop(element.scrollTop);
    setViewport(element.clientWidth);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the scroller only exists once a sheet has been read, and a new sheet needs the handler attached to the element that is there now
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    onScroll();
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [onScroll, sheet]);

  // A different sheet starts from the widths it states again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: path and the sheet's name are the only triggers this reset has
  useEffect(() => {
    setDragged(new Map());
  }, [path, active]);

  if (failed) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
        {t("editor.xlsx.unreadable")}
      </div>
    );
  }
  if (!workbook) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t("editor.xlsx.reading")}
      </div>
    );
  }
  if (workbook.sheets.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t("editor.xlsx.empty")}
      </div>
    );
  }

  const visible = windowOf(offsets, widths, scrollLeft, viewport, COLUMN_OVERSCAN);
  // The frozen columns are drawn in every row, so they are never part of the scrolling window.
  const columnsToDraw: number[] = [];
  for (let index = 0; index < frozenColumns; index += 1) columnsToDraw.push(index);
  for (let index = visible.start; index < visible.start + visible.count; index += 1) {
    if (index >= frozenColumns) columnsToDraw.push(index);
  }

  /** How tall a merged region is, from the rows it covers. */
  const mergedHeight = (row: number, span: number): number => {
    let height = 0;
    for (let index = row; index < row + span; index += 1) {
      height += heights.get(index) ?? DEFAULT_ROW_HEIGHT;
    }
    return height;
  };

  /**
   * One row of cells.
   *
   * `pinned` rows and columns are the frozen ones: they are drawn outside the scrolling body, and
   * the columns of a pinned row still slide with the horizontal scroll because the pane holds a
   * frozen pane's columns in place, not its whole page.
   */
  const rowOf = (index: number, height: number, sticky: boolean, top?: number) => (
    <div
      key={index}
      data-xlsx-row={index}
      className={[
        "absolute left-0 border-b border-border/30",
        // No hover fill: the grid is read, not browsed, and a highlight over a cell is louder
        // than the numbers in it.
        sticky ? "z-10 bg-background text-foreground" : "text-foreground",
      ].join(" ")}
      style={{ top, height, width: gridWidth }}
    >
      {columnsToDraw.map((column) => {
        const merge = merges.get(`${index}:${column}`);
        if (!draws(merge, index, column)) return null;
        const data = rowsByIndex.get(index)?.cells.find((entry) => entry.column === column);
        const style = data ? sheet?.styles[data.style] : undefined;
        // A conditional rule is the sheet asking a question about its own cells - which journal
        // names appear twice, which scores are above the line - so what it paints is drawn, unlike
        // the workbook's own decoration. It is worn over the cell's style and never replaces it.
        const rule =
          data?.conditional === undefined ? undefined : sheet?.styles[data.conditional];
        const width = merge
          ? total(widths.slice(merge.column, merge.column + merge.columnSpan))
          : widths[column];
        const cellHeight = merge ? mergedHeight(index, merge.rowSpan) : height;
        // A frozen column stays where it is while the rest scrolls under it.
        const pinned = column < frozenColumns;
        const left = pinned ? offsets[column] + scrollLeft : offsets[column];
        return (
          <div
            key={column}
            data-xlsx-cell={`${index}:${column}`}
            data-xlsx-justify={cellJustify(data?.kind ?? "text", style?.align ?? null)}
            className={[
              "absolute top-0 flex items-center overflow-hidden border-r border-border/40 px-1.5",
              cellJustify(data?.kind ?? "text", style?.align ?? null) === "right"
                ? "justify-end"
                : cellJustify(data?.kind ?? "text", style?.align ?? null) === "center"
                  ? "justify-center"
                  : "justify-start",
              pinned ? "z-20 bg-background" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{
              left,
              width,
              height: cellHeight,
              // The workbook's own font colour and fill are read but not drawn: the pane is themed,
              // so a cell reads in the theme's ink on the theme's surface rather than in whatever
              // red-on-green the file happens to carry. A conditional rule is the exception, because
              // what it states is not decoration but a statement about the value.
              fontWeight: style?.bold || rule?.bold ? 600 : undefined,
              fontStyle: style?.italic || rule?.italic ? "italic" : undefined,
              whiteSpace: style?.wrap ? "pre-wrap" : "nowrap",
              background: rule?.fill ?? undefined,
              color: rule?.color ?? undefined,
            }}
            title={data?.raw}
          >
            {data?.text ?? ""}
          </div>
        );
      })}
    </div>
  );

  // The rows the file holds in place, in the order they are stacked under the headings.
  let frozenTop = 0;
  const frozenOffsets: { index: number; top: number; height: number }[] = [];
  for (let index = 0; index < frozenRows; index += 1) {
    const height = heights.get(index) ?? DEFAULT_ROW_HEIGHT;
    frozenOffsets.push({ index, top: frozenTop, height });
    frozenTop += height;
  }

  // The headings and the frozen rows are pinned to the top of the pane rather than laid out above
  // the body: an offset block in the flow would put every virtualized row that much below the place
  // the virtualizer believes it is. Pinned, the scroll offsets the pane already tracks place them,
  // exactly as they place a frozen column.
  const headerStrip = (
    <div
      ref={headingStrip}
      onPointerDown={drag.onPointerDown}
      className="absolute left-0 z-30 bg-background"
      style={{
        top: scrollTop,
        height: HEADER_HEIGHT,
        width: gridWidth,
        cursor: drag.dragging === null ? undefined : "col-resize",
      }}
    >
      {columnsToDraw.map((column) => (
        <div
          key={column}
          data-xlsx-heading={column}
          className="absolute top-0 flex h-full items-center justify-center overflow-hidden border-r border-b border-border/50 text-[10.5px] text-muted-foreground"
          style={{
            left: column < frozenColumns ? offsets[column] + scrollLeft : offsets[column],
            width: widths[column],
          }}
        >
          {columnLabel(column)}
        </div>
      ))}
    </div>
  );

  const frozenStrip =
    frozenRows > 0 ? (
      <div
        className="absolute left-0 z-20 bg-background"
        style={{ top: scrollTop + HEADER_HEIGHT, height: frozenTop, width: gridWidth }}
      >
        {frozenOffsets.map(({ index, top, height }) => rowOf(index, height, true, top))}
      </div>
    ) : null;

  return (
    <div data-xlsx-preview="" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-2.5 py-1 text-[10.5px] text-muted-foreground">
        <span>{t("editor.xlsx.summary", { rows: rowCount, columns })}</span>
        {sheet?.truncated ? <span>{t("editor.xlsx.truncated")}</span> : null}
        {sheetFailed ? (
          <span className="text-destructive">{t("editor.xlsx.sheetUnreadable")}</span>
        ) : null}
      </div>
      <div
        ref={scroll}
        onScroll={onScroll}
        className="verta-doc-scroll relative min-h-0 flex-1 overflow-auto"
      >
        <div
          className="relative"
          style={{
            width: gridWidth,
            // The pinned strips cover the top of the pane, so the content carries their height as
            // room at the end; without it the last row could never be scrolled out from under them.
            height: virtualizer.getTotalSize() + HEADER_HEIGHT + frozenTop,
          }}
        >
          {virtualizer
            .getVirtualItems()
            // A frozen row is already drawn in the strip above; drawing it again would put it in
            // two places at once.
            .filter((item) => item.index >= frozenRows)
            .map((item) => rowOf(item.index, item.size, false, item.start))}
          {frozenStrip}
          {headerStrip}
        </div>
      </div>
      <div className="flex shrink-0 items-end gap-1 overflow-x-auto border-t border-border/60 px-1 pt-1">
        {workbook.sheets.map((entry) => (
          <button
            key={entry.name}
            type="button"
            data-xlsx-tab={entry.index}
            onClick={() => setActive(entry.name)}
            className={[
              "shrink-0 rounded-t border border-b-0 px-2 py-0.5 text-[10.5px]",
              entry.name === active
                ? "border-border bg-muted/70 text-foreground"
                : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            ].join(" ")}
          >
            {entry.name}
          </button>
        ))}
        {workbook.truncated ? (
          <span className="shrink-0 px-1 text-[10.5px] text-muted-foreground">
            {t("editor.xlsx.sheetsTruncated")}
          </span>
        ) : null}
      </div>
    </div>
  );
}
