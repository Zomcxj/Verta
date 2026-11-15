import { compactTokens, percentText } from "./tokens";
import { useState } from "react";

/** The geometry, in the 100-unit box the svg is drawn in. */
const RADIUS = 42;
const CENTER = 50;
/** Thin on purpose: the middle of the ring carries the total, and a fat ring leaves no room. */
const THICKNESS = 11;
/** What the slice under the pointer is drawn at, so "which part is this" is answered by shape too. */
const HOVER_THICKNESS = 15;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** How far the card sits from the pointer, and the room it needs to stay on screen. */
const CURSOR_GAP = 12;
const CARD_ROOM = 208;

export type ShareSlice = {
  /** Stable identity for React and for the hover. */
  key: string;
  /** What the slice is called, for its hover. */
  label: string;
  tokens: number;
  color: string;
};

type Props = {
  slices: ShareSlice[];
  /** Under the ring, what it is: the share of this table. */
  caption: string;
  /** In the middle of the ring, under the number. */
  unit: string;
  size?: number;
};

type Hover = {
  slice: ShareSlice;
  x: number;
  y: number;
};

/**
 * The whole split as one ring, beside the table that lists it.
 *
 * This is deliberately not a column of mini pies: a table already answers "how much did each row
 * take", and a 14px wedge next to a number is decoration. One donut answers the question a table
 * cannot - what shape the total is, how many rows matter, whether one agent or one model owns it -
 * and its middle is the total the table's rows sum to, so the ring says both what the split is and
 * what it is a split of. It is drawn from the same folded rows the table is drawn from, so the two
 * cannot disagree about what "other" means.
 *
 * The pointer reads the ring rather than the browser's `<title>`: the slice under it swells and the
 * rest step back, and the card that names it is the same one the session list floats over a row
 * (`verta-compact-card verta-float verta-float-mask`), so two answers about a thing look alike.
 */
export function SharePie({ slices, caption, unit, size = 132 }: Props) {
  const total = slices.reduce((sum, slice) => sum + slice.tokens, 0);
  const [hover, setHover] = useState<Hover | null>(null);
  let offset = 0;

  const track = (slice: ShareSlice, x: number, y: number) => {
    // Kept on screen: a card that opens past the right edge is a card nobody reads.
    const left = Math.min(x + CURSOR_GAP, window.innerWidth - CARD_ROOM);
    const top = Math.min(y + CURSOR_GAP, window.innerHeight - 90);
    setHover({ slice, x: Math.max(CURSOR_GAP, left), y: Math.max(CURSOR_GAP, top) });
  };

  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          viewBox="0 0 100 100"
          width={size}
          height={size}
          role="img"
          aria-label={`${caption} · ${compactTokens(total)}`}
          className="-rotate-90"
        >
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            strokeWidth={THICKNESS}
            className="stroke-foreground/[0.07]"
          />
          {total > 0
            ? slices.map((slice) => {
                const length = (slice.tokens / total) * CIRCUMFERENCE;
                const dash = `${length} ${CIRCUMFERENCE - length}`;
                const drawn = offset;
                offset += length;
                const lit = hover?.slice.key === slice.key;
                return (
                  <circle
                    key={slice.key}
                    data-usage-slice={slice.key}
                    cx={CENTER}
                    cy={CENTER}
                    r={RADIUS}
                    fill="none"
                    stroke={slice.color}
                    strokeWidth={lit ? HOVER_THICKNESS : THICKNESS}
                    strokeDasharray={dash}
                    strokeDashoffset={-drawn}
                    strokeLinecap="butt"
                    // The rest step back rather than disappearing: the ring is still the same split,
                    // and the point of the highlight is to isolate one slice, not to redraw the chart.
                    style={{
                      opacity: hover === null || lit ? 1 : 0.35,
                      transition:
                        "stroke-width var(--dur-fast) ease-out, opacity var(--dur-fast) ease-out",
                    }}
                    onPointerEnter={(event) =>
                      track(slice, event.clientX, event.clientY)
                    }
                    onPointerMove={(event) =>
                      track(slice, event.clientX, event.clientY)
                    }
                    onPointerLeave={() => setHover(null)}
                  />
                );
              })
            : null}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[15px] font-semibold leading-none tabular-nums">
            {compactTokens(total)}
          </span>
          <span className="mt-0.5 text-[8.5px] text-muted-foreground">{unit}</span>
        </div>
      </div>
      <span className="text-[9.5px] text-muted-foreground">{caption}</span>

      {hover ? (
        // The session list's own floating card: same surface, same floor for the tint, so a reader
        // who has seen one already knows what this is.
        <div
          data-usage-slice-card
          className="verta-compact-card verta-float verta-float-mask pointer-events-none fixed top-0 left-0 z-50 flex w-max max-w-[19rem] flex-col gap-0.5 rounded-xl bg-popover px-2.5 py-2 text-[11px] leading-relaxed text-popover-foreground shadow-lg ring-1 ring-foreground/5 dark:ring-foreground/10"
          style={{ transform: `translate(${hover.x}px, ${hover.y}px)` }}
        >
          <span className="flex min-w-0 items-center gap-1.5 font-medium">
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ background: hover.slice.color }}
            />
            <span className="truncate">{hover.slice.label}</span>
          </span>
          <span className="text-muted-foreground tabular-nums">
            {percentText(hover.slice.tokens, total)} ·{" "}
            {compactTokens(hover.slice.tokens)}
          </span>
        </div>
      ) : null}
    </div>
  );
}
