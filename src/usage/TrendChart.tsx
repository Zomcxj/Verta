import { cn } from "@/lib/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { axisMax, axisTicks } from "./axis";
import { useSeriesColors } from "./seriesColors";
import {
  compactTokens,
  OTHER_SERIES_KEY,
  percentText,
  type Trend,
} from "./tokens";

const HEIGHT = 190;
const PAD_LEFT = 44;
const PAD_RIGHT = 6;
const PAD_TOP = 8;
const PAD_BOTTOM = 20;
/** Bars leave a gap so two neighbouring days never read as one block. */
const BAR_GAP = 0.15;
const LINE_WIDTH = 2;
/**
 * The narrowest a day may be drawn before the plot starts scrolling.
 *
 * 180 days in the card's ~820px is 4.5px a day: a bar a hair wide, a stack of segments no one can
 * read, and x labels that collide. At 7px the bar and its gap are still separate things, and the
 * card scrolls to the days it cannot show.
 */
const MIN_PITCH = 7;

type Props = {
  trend: Trend;
  kind: "bars" | "line";
  /** `M/D` labels already come from the data; this only truncates for narrow windows. */
  peakLabel: string;
};

/** Catmull-Rom through the points, as cubic segments; only y is smoothed, x stays the day. */
function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[index - 1] ?? points[index];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[index + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    path += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return path;
}

export function TrendChart({ trend, kind, peakLabel }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<{
    index: number;
    x: number;
    y: number;
  } | null>(null);
  const colors = useSeriesColors(trend.series.length);

  // Pinned to the newest day: a range that scrolls should open on today, not on a year-old Monday.
  // Keyed on the data rather than on the width, so resizing the window does not yank the reader back
  // to the right edge while they are reading an older week.
  useEffect(() => {
    const element = scrollerRef.current;
    if (!element || trend.columns.length === 0) return;
    element.scrollLeft = element.scrollWidth;
  }, [trend]);

  // The plot scrolls on the wheel.
  //
  // A thin scrollbar was the only way to move a 180-day chart, and on this platform it is drawn as a
  // hairline that most people never find. A wheel over the plot moves it sideways: the vertical
  // delta is used because that is what a mouse sends, while a trackpad's horizontal gesture arrives
  // as `deltaX` and is used as it comes. A listener is added by hand because React's synthetic wheel
  // handler is passive, where `preventDefault` does nothing; and the gesture is left to the page once
  // an end is reached, so the chart never traps a scroll.
  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const span = element.scrollWidth - element.clientWidth;
      if (span <= 0) return;
      const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.deltaY;
      const next = element.scrollLeft + delta;
      if (next < 0 || next > span) return;
      event.preventDefault();
      element.scrollLeft = next;
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);


  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      setWidth(entries[0]?.contentRect.width ?? 640);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const available = Math.max(40, width - PAD_LEFT - PAD_RIGHT);
  // Days get MIN_PITCH each; the card is what scrolls when there are more of them than fit.
  const plotWidth = Math.max(available, trend.columns.length * MIN_PITCH);
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const columns = trend.columns;
  // The axis is the tallest day, rounded up to two significant digits: a scale with headroom draws
  // every bar shorter than it is, and the tallest one is the number the chart exists to show.
  const max = useMemo(
    () => axisMax(Math.max(...columns.map((column) => column.total), 0)),
    [columns],
  );
  const step = columns.length > 0 ? plotWidth / columns.length : plotWidth;
  const barWidth = Math.max(
    1,
    step * (1 - BAR_GAP) * (columns.length === 1 ? 0.6 / (1 - BAR_GAP) : 1),
  );

  const yOf = (value: number) =>
    PAD_TOP + plotHeight - (value / max) * plotHeight;
  const tickValues = axisTicks(max);

  // Four or five x labels, evenly spaced, always including the first and the last day.
  const labelEvery = Math.max(1, Math.ceil(columns.length / 6));
  const linePoints = columns.map((column, index) => ({
    x: index * step + step / 2,
    y: yOf(column.total),
  }));

  const colorOf = (key: string, index: number) =>
    key === OTHER_SERIES_KEY ? "var(--muted-foreground)" : colors[index];

  // The legend is a list of models, so it says the model's name and nothing else: a series used to
  // be a provider and a model, and qualifying a repeated label with the provider only papered over
  // one model counted twice (2.7B beside 679M, both "glm-5.3-flash"). The series are one per model
  // now, so a name is enough to tell two entries apart.
  const legendLabel = (entry: Trend["series"][number]) => entry.label;

  const hoveredColumn = hover === null ? null : (columns[hover.index] ?? null);
  const hoverIndex = hover?.index ?? -1;

  return (
    <div ref={wrapRef} className="relative w-full select-none">
      <div className="flex">
        {/* Outside the scroller: the scale stays put while the days move under it. */}
        <svg width={PAD_LEFT} height={HEIGHT} aria-hidden="true" className="shrink-0">
          {tickValues.map((value) => (
            <text
              key={value}
              x={PAD_LEFT - 6}
              y={yOf(value) + 3}
              textAnchor="end"
              fontSize={9.5}
              fill="var(--muted-foreground)"
            >
              {compactTokens(value)}
            </text>
          ))}
        </svg>
        <div
          ref={scrollerRef}
          className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden [-ms-overflow-style:none] [scrollbar-width:thin]"
        >
          <svg
            width={plotWidth + PAD_RIGHT}
            height={HEIGHT}
            role="img"
            aria-label={peakLabel}
            className="block overflow-visible"
          >
        {kind === "bars" ? (
          columns.map((column, index) => {
            let base = 0;
            return (
              <g key={column.day}>
                {column.values.map((value, seriesIndex) => {
                  if (value <= 0) return null;
                  const yTop = yOf(base + value);
                  const yBottom = yOf(base);
                  base += value;
                  const height = Math.max(0.6, yBottom - yTop);
                  return (
                    <rect
                      key={trend.series[seriesIndex]?.key ?? seriesIndex}
                      x={index * step + (step - barWidth) / 2}
                      y={yTop}
                      width={barWidth}
                      height={height}
                      fill={colorOf(
                        trend.series[seriesIndex]?.key,
                        seriesIndex,
                      )}
                      opacity={
                        hover === null || hover.index === index ? 1 : 0.45
                      }
                      rx={1.5}
                    />
                  );
                })}
              </g>
            );
          })
        ) : (
          <>
            <path
              d={`${smoothPath(linePoints)}`}
              fill="none"
              stroke={colors[0]}
              strokeWidth={LINE_WIDTH}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {hoveredColumn && hoverIndex >= 0 ? (
              <circle
                cx={linePoints[hoverIndex].x}
                cy={linePoints[hoverIndex].y}
                r={3}
                fill={colors[0]}
                stroke="var(--background)"
                strokeWidth={1.5}
              />
            ) : null}
          </>
        )}

        {columns.map((column, index) =>
          index % labelEvery === 0 || index === columns.length - 1 ? (
            <text
              key={`label-${column.day}`}
              x={index * step + step / 2}
              y={HEIGHT - 6}
              textAnchor="middle"
              fontSize={9.5}
              fill="var(--muted-foreground)"
            >
              {column.label.slice(5).replace("-", "/").replace(/^0/, "")}
            </text>
          ) : null,
        )}

        {/* The whole plot is the hover target, so the pointer never has to land on a 2px bar. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a hover readout over an SVG plot; every value it shows is also in the legend, the summary and the two tables, so it is an extra rather than the only way in. */}
        <rect
          x={0}
          y={PAD_TOP}
          width={plotWidth}
          height={plotHeight}
          fill="transparent"
          onMouseMove={(event) => {
            const plot =
              event.currentTarget.ownerSVGElement?.getBoundingClientRect();
            const outer = wrapRef.current?.getBoundingClientRect();
            if (!plot || !outer) return;
            const index = Math.min(
              columns.length - 1,
              Math.max(0, Math.floor((event.clientX - plot.left) / step)),
            );
            if (index < 0) return;
            // The tooltip is placed against the card, not the plot: the plot moves with the
            // scroll, its own coordinates do not.
            setHover({
              index,
              x: event.clientX - outer.left,
              y: event.clientY - outer.top,
            });
          }}
          onMouseLeave={() => setHover(null)}
        />
          </svg>
        </div>
      </div>

      {hover !== null && hoveredColumn ? (
        <div
          className={cn(
            "pointer-events-none absolute z-10 min-w-[168px] rounded-md border border-border/70 bg-popover/95 px-2 py-1.5 text-[10.5px] shadow-md backdrop-blur-sm",
          )}
          style={
            hover.x > width / 2
              ? { right: width - hover.x + 12, top: Math.max(0, hover.y - 8) }
              : { left: hover.x + 12, top: Math.max(0, hover.y - 8) }
          }
        >
          <div className="font-medium text-foreground">
            {hoveredColumn.label.slice(5).replace("-", "/")}
          </div>
          <div className="mt-1 flex flex-col gap-0.5">
            {trend.series.map((entry, index) => {
              const value = hoveredColumn.values[index] ?? 0;
              if (value <= 0) return null;
              return (
                <div key={entry.key} className="flex items-center gap-1.5">
                  <span
                    className="size-2 shrink-0 rounded-[2px]"
                    style={{ background: colorOf(entry.key, index) }}
                  />
                  <span className="max-w-[132px] truncate text-muted-foreground">
                    {legendLabel(entry)}
                  </span>
                  <span className="ml-auto tabular-nums text-foreground">
                    {compactTokens(value)}
                  </span>
                </div>
              );
            })}
          </div>
          {hoveredColumn.values.filter((value) => value > 0).length > 1 ? (
            <div className="mt-1 flex items-center gap-1.5 border-t border-border/60 pt-1">
              <span className="text-muted-foreground">合计</span>
              <span className="ml-auto font-medium tabular-nums text-foreground">
                {compactTokens(hoveredColumn.total)}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        {kind === "line" ? (
          <span className="text-[10px] text-muted-foreground">
            {compactTokens(trend.peak)}
          </span>
        ) : null}
        {trend.series.map((entry, index) => (
          <span
            key={entry.key}
            className="flex items-center gap-1 text-[10px] text-muted-foreground"
            title={entry.model ?? entry.label}
          >
            <span
              className="size-2 shrink-0 rounded-[2px]"
              style={{ background: colorOf(entry.key, index) }}
            />
            <span className="max-w-[150px] truncate">{legendLabel(entry)}</span>
            <span className="tabular-nums">
              {percentText(
                entry.total,
                trend.series.reduce((sum, s) => sum + s.total, 0),
              )}
              {" · "}
              {compactTokens(entry.total)}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
