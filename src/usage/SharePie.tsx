import { compactTokens, percentText } from "./tokens";

/** The geometry, in the 100-unit box the svg is drawn in. */
const RADIUS = 38;
const CENTER = 50;
const THICKNESS = 22;
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
  /** `null` for a neutral slice: the folded tail sums several rows and belongs to no one colour. */
  caption: string;
  size?: number;
};

/**
 * The whole split as one pie, beside the table that lists it.
 *
 * This is deliberately not a column of mini pies: a table already answers "how much did each row
 * take", and a 14px wedge next to a number is decoration. One donut answers the question a table
 * cannot - what shape the total is, how many rows matter, whether one agent or one model owns it -
 * and leaves the numbers in the column that reads them best. It is drawn from the same folded rows
 * the table is drawn from, so the two cannot disagree about what "other" means.
 */
export function SharePie({ slices, caption, size = 132 }: Props) {
  const total = slices.reduce((sum, slice) => sum + slice.tokens, 0);
  let offset = 0;

  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <svg
        viewBox="0 0 100 100"
        width={size}
        height={size}
        role="img"
        aria-label={caption}
        className="-rotate-90"
      >
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          strokeWidth={THICKNESS}
          className="stroke-foreground/[0.06]"
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
                  // Every slice but the first needs no separator; a hairline of the card behind it
                  // keeps two neighbours of similar hue apart without a visible gap everywhere.
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
      <span className="text-[9.5px] text-muted-foreground">{caption}</span>
    </div>
  );
}
