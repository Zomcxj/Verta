import { useEffect, useRef, useState } from "react";
import { useSeriesColors } from "./seriesColors";
import {
  compactTokens,
  fullTokens,
  percentText,
  type UsageView,
} from "./tokens";

/** The headline rolls to its new value: the one number a range change is felt in. */
const ROLL_MS = 450;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function useAnimatedNumber(target: number): number {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (prefersReducedMotion()) {
      from.current = target;
      setValue(target);
      return;
    }
    const origin = from.current;
    const started = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - started) / ROLL_MS);
      const eased = 1 - (1 - progress) ** 3;
      const next = origin + (target - origin) * eased;
      setValue(next);
      from.current = next;
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return value;
}

type Props = {
  view: UsageView;
  /** Which cache classes are being counted, so the composition bar can grey what is left out. */
  scope: { cacheRead: boolean; cacheWrite: boolean };
  language: string;
  /** `今日` / `本周` / `本月` / `总计`, appended to the headline. */
  rangeLabel: string;
  /** Today's day index, for naming the peak day. */
  today: number;
  labels: {
    composition: [string, string, string, string];
    activeDays: string;
    streak: string;
    perDay: string;
    peakDay: string;
    requests: string;
    favourite: string;
    shareOfAll: string;
    daysUnit: (count: number) => string;
    perDayLine: (value: string) => string;
    emptyRange: string;
    today: string;
    yesterday: string;
    unnamedModel: string;
  };
};

export function SummaryCard({
  view,
  scope,
  language,
  rangeLabel,
  today,
  labels,
}: Props) {
  const animated = useAnimatedNumber(view.tokens);
  const colors = useSeriesColors(4);

  const classes: { label: string; value: number; counted: boolean }[] = [
    { label: labels.composition[0], value: view.parts.input, counted: true },
    { label: labels.composition[1], value: view.parts.output, counted: true },
    {
      label: labels.composition[2],
      value: view.parts.cacheRead,
      counted: scope.cacheRead,
    },
    {
      label: labels.composition[3],
      value: view.parts.cacheWrite,
      counted: scope.cacheWrite,
    },
  ];
  const barTotal = classes.reduce((sum, entry) => sum + entry.value, 0);

  const peakNote =
    view.peak === null
      ? null
      : view.peak.day === today
        ? labels.today
        : view.peak.day === today - 1
          ? labels.yesterday
          : view.peak.label;

  const stats = [
    {
      label: labels.activeDays,
      value: labels.daysUnit(view.activeDays),
      note: null,
    },
    { label: labels.streak, value: labels.daysUnit(view.streak), note: null },
    {
      label: labels.perDay,
      value: view.activeDays > 0 ? compactTokens(view.perDay) : "—",
      note: null,
    },
    {
      label: labels.peakDay,
      value: view.peak ? compactTokens(view.peak.tokens) : "—",
      note: peakNote,
    },
    {
      // One event is one answer the agent paid for: a request, in the tool's own terms.
      label: labels.requests,
      value: view.events.toLocaleString(language),
      note: null,
    },
    {
      label: labels.favourite,
      value: view.favourite
        ? (view.favourite.model ?? labels.unnamedModel)
        : "—",
      note: view.favourite ? compactTokens(view.favourite.tokens) : null,
    },
    {
      label: labels.shareOfAll,
      // `null` is the `all` range itself, which has nothing bigger to be a share of.
      value: view.shareOfAll === null ? "—" : percentText(view.shareOfAll, 1),
      note: null,
    },
  ] as { label: string; value: string; note: string | null }[];

  return (
    <section data-usage-summary>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span
          className="text-[22px] font-semibold tabular-nums text-foreground"
          data-usage-total={Math.round(view.tokens)}
          title={fullTokens(view.tokens, language)}
        >
          {fullTokens(animated, language)}
        </span>
        <span className="text-[11px] text-muted-foreground">
          tokens · {rangeLabel}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-[11px] text-muted-foreground">
        <span className="text-[13px] font-medium tabular-nums text-foreground/80">
          ≈ {compactTokens(view.tokens)}
        </span>
        <span>· {labels.perDayLine(compactTokens(view.perDay))}</span>
      </div>

      {barTotal > 0 ? (
        <>
          <div className="mt-2.5 flex h-2.5 w-full overflow-hidden rounded-[3px]">
            {classes.map((entry, index) =>
              entry.value <= 0 ? null : (
                <span
                  key={entry.label}
                  className="h-full first:rounded-l-[3px] last:rounded-r-[3px]"
                  style={{
                    width: `${(entry.value / barTotal) * 100}%`,
                    minWidth: 1,
                    background: colors[index],
                    // A class the switch leaves out keeps its segment, at a third of the weight:
                    // the bar keeps its shape and the legend says what the total does not include.
                    opacity: entry.counted ? 1 : 0.3,
                  }}
                />
              ),
            )}
          </div>
          {/* The four classes are the first thing a person reads under the headline, so they are
              drawn as four blocks rather than a line of footnotes: the share at a size the eye
              lands on, the tokens under it. */}
          <div className="mt-2 grid grid-cols-4 gap-x-3">
            {classes.map((entry, index) =>
              entry.value <= 0 ? null : (
                <div key={entry.label} className="min-w-0">
                  <div className="flex items-center gap-1 text-[9.5px] text-muted-foreground">
                    <span
                      className="size-2 shrink-0 rounded-[2px]"
                      style={{
                        background: colors[index],
                        opacity: entry.counted ? 1 : 0.3,
                      }}
                    />
                    <span className="truncate">{entry.label}</span>
                  </div>
                  <div
                    className="text-[15px] font-semibold tabular-nums text-foreground"
                    style={{ opacity: entry.counted ? 1 : 0.45 }}
                  >
                    {percentText(entry.value, barTotal)}
                  </div>
                  <div className="text-[10.5px] tabular-nums text-muted-foreground">
                    {compactTokens(entry.value)}
                  </div>
                </div>
              ),
            )}
          </div>
        </>
      ) : null}

      <div className="mt-3 grid grid-cols-4 gap-x-3 gap-y-2">
        {stats.map((stat) => (
          <div key={stat.label} className="min-w-0">
            <div className="text-[9.5px] text-muted-foreground">
              {stat.label}
            </div>
            <div
              className="truncate text-[13px] font-medium tabular-nums text-foreground"
              title={stat.value}
            >
              {stat.value}
            </div>
            {stat.note ? (
              <div className="truncate text-[9.5px] text-muted-foreground">
                {stat.note}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {view.tokens === 0 ? (
        <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
          {labels.emptyRange}
        </div>
      ) : null}
    </section>
  );
}
