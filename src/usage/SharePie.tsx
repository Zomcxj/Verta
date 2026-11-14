import { compactTokens, percentText } from "./tokens";

/** The geometry, in the 100-unit box the svg is drawn in. */
const RADIUS = 42;
const CENTER = 50;
/** Thin on purpose: the middle of the ring carries the total, and a fat ring leaves no room. */
const THICKNESS = 11;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

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

/**
 * The whole split as one ring, beside the table that lists it.
 *
 * This is deliberately not a column of mini pies: a table already answers "how much did each row
 * take", and a 14px wedge next to a number is decoration. One donut answers the question a table
 * cannot - what shape the total is, how many rows matter, whether one agent or one model owns it -
 * and its middle is the total the table's rows sum to, so the ring says both what the split is and
 * what it is a split of. It is drawn from the same folded rows the table is drawn from, so the two
 * cannot disagree about what "other" means.
 */
export function SharePie({ slices, caption, unit, size = 132 }: Props) {
  const total = slices.reduce((sum, slice) => sum + slice.tokens, 0);
  let offset = 0;

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
                return (
                  <circle
                    key={slice.key}
                    cx={CENTER}
                    cy={CENTER}
                    r={RADIUS}
                    fill="none"
                    stroke={slice.color}
                    strokeWidth={THICKNESS}
                    strokeDasharray={dash}
                    strokeDashoffset={-drawn}
                    strokeLinecap="butt"
                  >
                    <title>
                      {`${slice.label} · ${percentText(slice.tokens, total)} · ${compactTokens(slice.tokens)}`}
                    </title>
                  </circle>
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
    </div>
  );
}
