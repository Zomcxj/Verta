import { cn } from "@/lib/utils";
import { useMemo, useState } from "react";
import { compactTokens, percentText, type UsageRow } from "./tokens";

/** The wedge, drawn in a 20-unit box so a 16px render still has clean edges. */
function SharePie({ share, color }: { share: number; color: string }) {
  const radius = 8;
  const center = 10;
  const sweep = Math.min(1, Math.max(0, share));
  // A full turn has no start and no end, and an arc from a point to itself draws nothing.
  const path =
    sweep >= 0.9995
      ? `M ${center} ${center - radius} A ${radius} ${radius} 0 1 1 ${center - 0.01} ${center - radius} Z`
      : sweep <= 0.0005
        ? ""
        : (() => {
            const angle = sweep * Math.PI * 2 - Math.PI / 2;
            const x = center + radius * Math.cos(angle);
            const y = center + radius * Math.sin(angle);
            const large = sweep > 0.5 ? 1 : 0;
            return `M ${center} ${center} L ${center} ${center - radius} A ${radius} ${radius} 0 ${large} 1 ${x} ${y} Z`;
          })();
  return (
    <svg
      viewBox="0 0 20 20"
      width={14}
      height={14}
      className="shrink-0"
      aria-hidden="true"
    >
      <circle
        cx={center}
        cy={center}
        r={radius}
        className="fill-foreground/10"
      />
      {path ? <path d={path} fill={color} /> : null}
    </svg>
  );
}

export type SortKey =
  | "name"
  | "total"
  | "input"
  | "output"
  | "cacheRead"
  | "share";

type Props = {
  /** A stable name for the probe: the two tables share row markup, so the rows need a scope. */
  id: string;
  /** Header of the first column, which is the one the rows are named by. */
  nameHeader: string;
  labels: {
    total: string;
    input: string;
    output: string;
    cacheRead: string;
    share: string;
  };
  rows: UsageRow[];
  /** What the first column shows: a tool id, or a model id. */
  nameOf: (row: UsageRow) => string;
  /** A quieter second line under the name, e.g. the provider behind a model. */
  noteOf?: (row: UsageRow) => string | null;
  emptyLabel: string;
  onPick?: (row: UsageRow) => void;
  /** An agent mark before the name, so a tool row is recognisable without reading it. */
  iconOf?: (row: UsageRow) => React.ReactNode;
  /** The colour of a row's share pie. */
  pieColorOf?: (row: UsageRow) => string;
};

const NUM_COLUMNS = "58px 58px 58px 58px 30px";

/** Which way a newly chosen column sorts: names read up, numbers read down. */
function defaultDescending(key: SortKey): boolean {
  return key !== "name";
}

function sortValue(row: UsageRow, key: SortKey): string | number {
  switch (key) {
    case "name":
      return row.label;
    case "total":
      return row.tokens;
    case "input":
      return row.parts.input;
    case "output":
      return row.parts.output;
    case "cacheRead":
      return row.parts.cacheRead;
    case "share":
      return row.share;
  }
}

export function UsageTable({
  id,
  nameHeader,
  labels,
  rows,
  nameOf,
  noteOf,
  emptyLabel,
  onPick,
  iconOf,
  pieColorOf,
}: Props) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: "total",
    desc: true,
  });

  const sorted = useMemo(() => {
    const list = [...rows];
    list.sort((left, right) => {
      const a = sortValue(left, sort.key);
      const b = sortValue(right, sort.key);
      const order =
        typeof a === "string" && typeof b === "string"
          ? a.localeCompare(b)
          : Number(a) - Number(b);
      // Ties fall back to the name so rows never shuffle between two identical reads.
      const settled =
        order !== 0 ? order : left.label.localeCompare(right.label);
      return sort.desc ? -settled : settled;
    });
    return list;
  }, [rows, sort]);

  const total = sorted.reduce((sum, row) => sum + row.tokens, 0);

  const header = (label: string, key: SortKey, extra?: string) => (
    <button
      type="button"
      onClick={() =>
        setSort((current) =>
          current.key === key
            ? { key, desc: !current.desc }
            : { key, desc: defaultDescending(key) },
        )
      }
      className={cn(
        "cursor-pointer truncate text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        sort.key === key ? "text-foreground" : "text-muted-foreground",
        extra,
      )}
    >
      {label}
      {sort.key === key ? (sort.desc ? " ▼" : " ▲") : ""}
    </button>
  );

  return (
    <div className="text-[11px]" data-usage-table={id}>
      <div
        className="grid items-center gap-1 pb-1 text-[10px]"
        style={{ gridTemplateColumns: `minmax(0, 1fr) ${NUM_COLUMNS}` }}
      >
        {header(nameHeader, "name")}
        {header(labels.total, "total", "text-right")}
        {header(labels.input, "input", "text-right")}
        {header(labels.output, "output", "text-right")}
        {header(labels.cacheRead, "cacheRead", "text-right")}
        {header(labels.share, "share", "text-right")}
      </div>

      {sorted.length === 0 ? (
        <div className="py-3 text-[11px] text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        <div
          className="max-h-[125px] overflow-y-auto [-ms-overflow-style:none] [scrollbar-width:thin]"
          data-usage-table-body
        >
          {sorted.map((row, index) => (
            <button
              key={row.key}
              type="button"
              data-usage-row={row.key}
              data-usage-row-tokens={row.tokens}
              onClick={() => onPick?.(row)}
              className={cn(
                "grid w-full items-center gap-1 rounded-sm border-0 bg-transparent px-0.5 py-[3px] text-left transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                index % 2 === 1 && "bg-foreground/[0.03]",
                onPick ? "cursor-pointer" : "cursor-default",
                onPick && "hover:bg-foreground/[0.07]",
              )}
              style={{ gridTemplateColumns: `minmax(0, 1fr) ${NUM_COLUMNS}` }}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {iconOf?.(row) ? (
                  <span className="shrink-0 text-foreground/80">
                    {iconOf(row)}
                  </span>
                ) : null}
                <span className="min-w-0">
                  <span className="block truncate font-medium text-foreground">
                    {nameOf(row)}
                  </span>
                  {noteOf?.(row) ? (
                    <span className="block truncate text-[9.5px] text-muted-foreground">
                      {noteOf(row)}
                    </span>
                  ) : null}
                </span>
              </span>
              <span className="text-right tabular-nums text-foreground">
                {compactTokens(row.tokens)}
              </span>
              <span className="text-right tabular-nums text-muted-foreground">
                {compactTokens(row.parts.input)}
              </span>
              <span className="text-right tabular-nums text-muted-foreground">
                {compactTokens(row.parts.output)}
              </span>
              <span className="text-right tabular-nums text-muted-foreground">
                {compactTokens(row.parts.cacheRead)}
              </span>
              <span
                className="flex justify-end"
                // The number is gone from the cell but not from the interface: hovering says it.
                title={percentText(row.tokens, total)}
              >
                <SharePie
                  share={row.tokens / total}
                  color={pieColorOf?.(row) ?? "var(--color-primary, currentColor)"}
                />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
