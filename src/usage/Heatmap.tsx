import { useEffect, useRef, useState } from "react";
import { useAccentAlpha } from "./seriesColors";
import { compactTokens, dateOfDay, type HeatCell } from "./tokens";

/** Cell alphas for levels 1..4: visibly four steps without the top one turning into a block. */
const LEVEL_ALPHA = [0, 0.18, 0.38, 0.62, 0.92];
const MONTH_ROW = 14;

type Props = {
  cells: HeatCell[];
  weeks: number;
  /** Interface strings, passed in so this file holds no copy. */
  labels: {
    less: string;
    more: string;
    scale: string;
    none: string;
  };
};

export function Heatmap({ cells, weeks, labels }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(520);
  const [hover, setHover] = useState<{
    label: string;
    tokens: number;
    known: boolean;
    left: number;
    top: number;
  } | null>(null);
  const accent = useAccentAlpha();

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      setWidth(entries[0]?.contentRect.width ?? 520);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The grid is `weeks` columns of `size + gap`, so the pitch is what has to fit, not the cell: the
  // old arithmetic sized the cell from the width and then added a gap to every column, which put the
  // last weeks outside the card (53 x 16 = 848 in an 820px card). The pitch is the width divided by
  // the weeks, with no upper bound - a cap left the card's right-hand side empty once the window was
  // wider than 53 x 18, and a year of days that does not reach the edge reads as missing days.
  const gap = 2;
  const pitch = Math.max(7, width / weeks);
  const size = Math.max(5, pitch - gap);

  // Month names go on the first column that starts a new month, which is how a contribution graph
  // labels a year without a widow row of them.
  const months: (number | null)[] = [];
  let lastMonth = -1;
  for (let week = 0; week < weeks; week += 1) {
    const first = cells[week * 7];
    if (!first) {
      months.push(null);
      continue;
    }
    const { month, date } = dateOfDay(first.day);
    if (month !== lastMonth && (date <= 7 || week === 0)) {
      months.push(month);
      lastMonth = month;
    } else {
      months.push(null);
    }
  }

  return (
    <div ref={wrapRef} className="relative w-full">
      <div
        className="grid text-[9.5px] text-muted-foreground"
        style={{
          gridTemplateColumns: `repeat(${weeks}, ${pitch}px)`,
          height: MONTH_ROW,
        }}
      >
        {months.map((month, index) => (
          <span
            key={cells[index * 7]?.day ?? index}
            className="overflow-visible whitespace-nowrap"
          >
            {month === null ? "" : `${month}月`}
          </span>
        ))}
      </div>
      <div
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${weeks}, ${pitch}px)`,
          gridTemplateRows: `repeat(7, ${pitch}px)`,
          gridAutoFlow: "column",
        }}
      >
        {cells.map((cell) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: the hover is an extra, not the only way to read these numbers - every day's total is also in the summary, the chart and the two tables, and 371 focus stops would be worse than the hover is worth.
          <div
            key={cell.day}
            data-usage-heat={cell.day}
            data-usage-heat-level={cell.level}
            data-usage-heat-tokens={cell.tokens}
            className="rounded-[2px]"
            style={{
              width: size,
              height: size,
              // Level 0 is a real colour, not transparency: an empty day and a day outside the
              // history must not look the same.
              background:
                cell.level === 0
                  ? "color-mix(in oklab, var(--foreground) 8%, transparent)"
                  : accent(LEVEL_ALPHA[cell.level]),
              opacity: cell.known ? 1 : 0,
            }}
            onMouseEnter={(event) => {
              if (!cell.known) return;
              const box = wrapRef.current?.getBoundingClientRect();
              const own = event.currentTarget.getBoundingClientRect();
              if (!box) return;
              setHover({
                label: cell.label,
                tokens: cell.tokens,
                known: cell.known,
                left: own.left - box.left + size / 2,
                top: own.top - box.top,
              });
            }}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </div>

      {hover ? (
        <div
          className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md border border-border/70 bg-popover/95 px-1.5 py-1 text-[10px] shadow-md backdrop-blur-sm"
          style={{
            left: Math.min(
              Math.max(0, hover.left - 40),
              Math.max(0, width - 96),
            ),
            top: hover.top - 34,
          }}
        >
          <div className="text-foreground">{hover.label}</div>
          <div className="text-muted-foreground">
            {hover.tokens > 0
              ? `${compactTokens(hover.tokens)} tokens`
              : labels.none}
          </div>
        </div>
      ) : null}

      <div className="mt-1.5 flex items-center gap-1 text-[9.5px] text-muted-foreground">
        <span>{labels.less}</span>
        {LEVEL_ALPHA.slice(1).map((alpha) => (
          <span
            key={alpha}
            className="size-2.5 rounded-[2px]"
            style={{ background: accent(alpha) }}
          />
        ))}
        <span>{labels.more}</span>
        <span className="ml-1.5">{labels.scale}</span>
      </div>
    </div>
  );
}
