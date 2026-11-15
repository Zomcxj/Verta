import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WindowControls } from "@/components/WindowControls";
import { AgentIcon, agentColor } from "@/modules/launcher/lib/agentIcon";
import { IS_MAC } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useLanguage, useT } from "@/modules/i18n";
import { WindowActivityBridge, WindowVibrancyBridge } from "@/modules/theme";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Heatmap } from "./Heatmap";
import { SummaryCard } from "./SummaryCard";
import {
  buildHeatmap,
  buildTrend,
  buildView,
  CHART_RANGES,
  type ChartRange,
  dayOf,
  isToolAvailable,
  localOffsetMinutes,
  type TokenScope,
  USAGE_RANGES,
  type UsagePayload,
  type UsageRange,
} from "./tokens";
import { useSeriesColors } from "./seriesColors";
import { SharePie } from "./SharePie";
import { TrendChart } from "./TrendChart";
import { UsageTable } from "./UsageTable";

const RANGE_KEYS = {
  today: "usage.rangeToday",
  week: "usage.rangeWeek",
  month: "usage.rangeMonth",
  all: "usage.rangeAll",
} as const;

const CHART_RANGE_KEYS = {
  7: "usage.chart7",
  30: "usage.chart30",
  90: "usage.chart90",
  180: "usage.chart180",
  0: "usage.chartAll",
} as const;

const HEATMAP_WEEKS = 53;

/**
 * The agents this window reads. A store that is absent simply has no rows.
 *
 * The three terminal agents keep sessions as well (opencode, pi, Claude Code); the three IDE agents
 * (zcode, workbuddy, dsh) are usage only, which is all they record.
 */
/**
 * The shares the model table can fold at, in percent.
 *
 * A long history has a long tail of models used once; 1% is the default because it keeps the models
 * that shape the total and drops the noise, and the others are there for the runs where the answer
 * changes - a month with twenty near-equal models reads better at 5%.
 */
// The steps a model's share can be folded below. 0.1 is there because most of this machine's
// models sit between it and half a percent, and 5 was never the interesting end of the range: by
// the time a row is worth 5%, folding it away hides a model the reader came for.
const FOLD_STEPS = [0.1, 0.5, 0.8, 1, 2] as const;
/**
 * What the window counts, fixed.
 *
 * Cache reads and writes are part of the total, and there is no switch to take them out: a share
 * that drops most of what an agent spent answers a different question. `TokenScope` stays in the
 * data layer, where a test or a probe can still ask for one class on its own.
 */
const USAGE_SCOPE: TokenScope = { cacheRead: true, cacheWrite: true };
const FOLD_DEFAULT = 0.01;

const TOOLS = [
  // Terminal agents first, then the IDE ones, each group by its first letter: the row reads as the
  // same two families the product talks about, and the order does not move when one is uninstalled.
  "claude",
  "opencode",
  "pi",
  "dsh",
  "workbuddy",
  "zcode",
] as const;

export function UsageApp(): JSX.Element {
  const t = useT();
  const language = useLanguage();
  const [range, setRange] = useState<UsageRange>("month");
  const [foldBelow, setFoldBelow] = useState(FOLD_DEFAULT);
  const scope = USAGE_SCOPE;
  const [chartRange, setChartRange] = useState<ChartRange>(30);
  const [chartKind, setChartKind] = useState<"bars" | "line">("bars");
  const [tool, setTool] = useState<string | null>(null);
  const [payload, setPayload] = useState<UsagePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Answers can arrive out of order when refresh is pressed twice quickly; only the newest paints.
  const requestRef = useRef(0);

  const load = useCallback(() => {
    const ticket = ++requestRef.current;
    setLoading(true);
    setError(null);
    void invoke<UsagePayload>("agent_usage_events", {
      // Everything, once. The ranges are sums over these days, so switching between them - or
      // ticking a cache switch - never pays for the scan again.
      sinceMs: null,
      offsetMinutes: localOffsetMinutes(),
      cacheRead: true,
      cacheWrite: true,
    })
      .then((answer) => {
        if (ticket !== requestRef.current) return;
        setPayload(answer);
        setUpdatedAt(Date.now());
      })
      .catch((reason) => {
        if (ticket !== requestRef.current) return;
        setError(String(reason));
      })
      .finally(() => {
        if (ticket !== requestRef.current) return;
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const title = t("usage.windowTitle");
    document.title = title;
    void getCurrentWebviewWindow()
      .setTitle(title)
      .catch(() => {});
  }, [t]);

  const offset = payload?.offsetMinutes ?? localOffsetMinutes();

  const today = dayOf(Date.now(), offset);

  const view = useMemo(
    () =>
      payload
        ? buildView(payload, { range, tool, scope, today, foldBelow })
        : null,
    [payload, range, tool, scope, today, foldBelow],
  );
  // The model pie wears the chart's own colours, so a model is the same colour in both places.
  const modelColors = useSeriesColors(view?.byModel.length ?? 1);
  const agentSlices = useMemo(
    () =>
      (view?.byTool ?? []).map((row) => ({
        key: row.key,
        label: row.label,
        tokens: row.tokens,
        color: agentColor(row.tool ?? row.label),
      })),
    [view],
  );
  const modelSlices = useMemo(
    () =>
      (view?.byModel ?? []).map((row, index) => ({
        key: row.key,
        label: row.other
          ? t("usage.other")
          : (row.model ?? t("usage.unnamedModel")),
        tokens: row.tokens,
        // The folded row belongs to no model, so it gets the neutral the trend chart gives it.
        color: row.other
          ? "color-mix(in oklab, var(--foreground) 26%, transparent)"
          : (modelColors[index] ?? modelColors[0]),
      })),
    [view, modelColors, t],
  );
  // Keyed rather than positioned: the table sorts, and a slice colour must not follow the sort.
  const modelColorByKey = useMemo(
    () => new Map(modelSlices.map((slice) => [slice.key, slice.color])),
    [modelSlices],
  );
  const trend = useMemo(
    () =>
      payload
        ? buildTrend(payload, {
            range: chartRange,
            tool,
            scope,
            today,
            otherLabel: t("usage.other"),
          })
        : null,
    [payload, chartRange, tool, scope, today, t],
  );
  const heatmap = useMemo(
    () =>
      payload
        ? buildHeatmap(payload, { tool, scope, today, weeks: HEATMAP_WEEKS })
        : null,
    [payload, tool, scope, today],
  );

  // The probe reads this, so what it checks is what the window drew.
  useEffect(() => {
    const w = window as unknown as { __vertaUsage?: () => unknown };
    w.__vertaUsage = () =>
      payload && view && trend && heatmap
        ? {
            range,
            tool,
            scope,
            tokens: view.tokens,
            rustTokens: payload.tokens,
            events: view.events,
            days: view.days.length,
            activeDays: view.activeDays,
            streak: view.streak,
            peak: view.peak,
            tools: view.byTool.map((row) => ({
              label: row.label,
              tokens: row.tokens,
            })),
            models: view.byModel.length,
            availableTools: payload.availableTools ?? null,
            modelOf: view.byModel.slice(0, 3).map((row) => ({
              label: row.label,
              tokens: row.tokens,
            })),
            cells: view.days.reduce((sum, day) => sum + day.cells.length, 0),
            trend: {
              columns: trend.columns.length,
              series: trend.series.map((entry) => ({
                label: entry.label,
                total: entry.total,
              })),
              peak: trend.peak,
            },
            heat: {
              cells: heatmap.cells.length,
              painted: heatmap.cells.filter((cell) => cell.level > 0).length,
            },
            failures: payload.failures,
          }
        : null;
  }, [payload, view, trend, heatmap, range, tool, scope]);

  const chips = <T extends string | number | null>(
    values: readonly T[],
    current: T,
    onPick: (value: T) => void,
    label: (value: T) => string,
    ariaLabel: string,
    iconOf?: (value: T) => ReactNode,
    disabledOf?: (value: T) => boolean,
  ) => (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex items-center gap-0.5 rounded-md bg-foreground/[0.05] p-0.5"
    >
      {values.map((value) => {
        const icon = iconOf?.(value) ?? null;
        const text = label(value);
        // An agent that is not installed here has nothing to filter to. Its mark stays in the row -
        // the set of agents the window knows does not change with what is installed - but it is not
        // a button, so it neither takes a click nor a tab stop.
        if (disabledOf?.(value)) {
          return (
            <span
              key={String(value)}
              data-usage-chip={String(value)}
              data-usage-unavailable
              aria-disabled="true"
              title={`${text} · ${t("usage.notInstalled")}`}
              className="flex cursor-not-allowed items-center rounded px-1.5 py-[3px] opacity-40"
            >
              {icon}
            </span>
          );
        }
        // A chip that has a mark says what it is with the mark alone; the name is one hover away.
        // Six agents plus their names is most of an 880px header, and the marks are what a glance
        // reads anyway. The name stays as the accessible name, so it is still spoken.
        const button = (
          <button
            key={String(value)}
            type="button"
            role="tab"
            // A stable handle for the probe: the label is interface text and follows the language.
            data-usage-chip={String(value)}
            aria-label={icon ? text : undefined}
            aria-selected={current === value}
            onClick={() => onPick(value)}
            className={cn(
              "flex cursor-pointer items-center gap-1 rounded text-[10.5px] whitespace-nowrap outline-none transition-[background-color,color,transform] duration-150 focus-visible:ring-2 focus-visible:ring-primary/40 active:scale-[0.97]",
              icon ? "px-1.5 py-[3px]" : "px-2 py-0.5",
              current === value
                ? "bg-primary font-medium text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {icon ? <span className="shrink-0">{icon}</span> : text}
          </button>
        );
        if (!icon) return button;
        return (
          <Tooltip key={String(value)}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {text}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );

  const card = (
    title: string,
    extra: ReactNode,
    body: ReactNode,
    className?: string,
  ) => (
    <section
      className={cn(
        "min-w-0 rounded-[10px] border border-border/60 bg-card/60 px-3 py-2.5",
        className,
      )}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <h2 className="text-[12px] font-semibold text-foreground">{title}</h2>
        {extra}
      </div>
      {body}
    </section>
  );

  return (
    <div className="usage-shell flex h-screen flex-col overflow-hidden bg-background text-foreground select-none">
      <WindowVibrancyBridge />
      <header
        data-tauri-drag-region
        className={cn(
          "flex h-11 shrink-0 items-center gap-2 border-b border-border/60 bg-card/60",
          IS_MAC ? "pr-3 pl-22" : "pr-0 pl-3",
        )}
      >
        <span
          className="text-[12px] font-medium text-foreground"
          data-tauri-drag-region
        >
          {t("usage.title")}
        </span>
        <div className="ml-1" />
        {chips(
          USAGE_RANGES,
          range,
          setRange,
          (value) => t(RANGE_KEYS[value]),
          t("usage.range"),
        )}
        <div className="ml-auto" />
        <button
          type="button"
          disabled={loading}
          onClick={load}
          className="cursor-pointer rounded-md px-2 py-1 text-[11px] text-muted-foreground outline-none transition-colors duration-[var(--dur-base)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
        >
          {loading ? t("usage.loading") : t("usage.refresh")}
        </button>
        <WindowControls closeOnly />
      </header>
      <WindowActivityBridge />

      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/40 px-4 py-1.5">
        {chips(
          [null, ...TOOLS] as (string | null)[],
          tool,
          setTool,
          (value) => value ?? t("usage.allTools"),
          t("usage.agent"),
          // The same marks the session list uses, so "which agent" is read at a glance here too.
          (value) =>
            value === null ? null : <AgentIcon agent={value} size={11} />,
          (value) => !isToolAvailable(payload?.availableTools, value),
        )}
        <span className="text-[10px] text-muted-foreground">
          {view
            ? t("usage.statusLine", {
                days: view.days.length,
                events: view.events,
              })
            : ""}
        </span>
        {updatedAt && !loading ? (
          <span className="text-[10px] text-muted-foreground">
            {t("usage.updatedAt", {
              time: new Date(updatedAt).toLocaleTimeString(language, {
                hour: "2-digit",
                minute: "2-digit",
              }),
            })}
          </span>
        ) : null}
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-3 [-ms-overflow-style:none] [scrollbar-width:thin]">
        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] break-words whitespace-pre-line text-destructive">
            {error}
          </div>
        ) : null}

        {payload && payload.failures.length > 0 ? (
          <div className="mb-3 rounded-md border border-amber-500/35 bg-amber-500/8 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400">
            <div className="font-medium">
              {t("usage.failures", { count: payload.failures.length })}
            </div>
            <div className="mt-0.5 break-words whitespace-pre-line opacity-80">
              {payload.failures.join("\n")}
            </div>
          </div>
        ) : null}

        {!payload || !view || !trend || !heatmap ? (
          <div className="flex h-full flex-col items-center justify-center gap-2.5 text-center text-[12px] text-muted-foreground">
            {loading ? (
              <>
                {/* The read walks every store on the machine, so it takes seconds; how many is a
                    guess, and a sentence that guesses at a wait reads as a warning. A spinner
                    says the same thing without the number. */}
                <span
                  aria-hidden="true"
                  className="size-5 animate-spin rounded-full border-2 border-foreground/15 border-t-foreground/60"
                />
                <span>{t("usage.loading")}</span>
              </>
            ) : (
              t("usage.empty")
            )}
          </div>
        ) : payload.days.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            <div className="text-[13px] text-amber-600 dark:text-amber-400">
              {t("usage.noData")}
            </div>
            <div className="max-w-[420px] text-[11px] text-muted-foreground">
              {t("usage.noDataHint")}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <section className="rounded-[10px] border border-border/60 bg-card/60 px-3 py-2.5">
              <SummaryCard
                view={view}
                scope={scope}
                language={language}
                rangeLabel={t(RANGE_KEYS[range])}
                today={today}
                labels={{
                  composition: [
                    t("usage.colInput"),
                    t("usage.colOutput"),
                    t("usage.colCacheRead"),
                    t("usage.colCacheWrite"),
                  ],
                  activeDays: t("usage.activeDays"),
                  streak: t("usage.streak"),
                  perDay: t("usage.perDay"),
                  peakDay: t("usage.peakDay"),
                requests: t("usage.requests"),
                  favourite: t("usage.favourite"),
                  shareOfAll: t("usage.shareOfAll"),
                  daysUnit: (count) => t("usage.daysUnit", { count }),
                  perDayLine: (value) => t("usage.perDayLine", { value }),
                  emptyRange: t("usage.emptyRange", {
                    range: t(RANGE_KEYS[range]),
                  }),
                  today: t("usage.today"),
                  yesterday: t("usage.yesterday"),
                  unnamedModel: t("usage.unnamedModel"),
                }}
              />
            </section>

            {card(
              t("usage.trend"),
              <>
                {chips(
                  CHART_RANGES,
                  chartRange,
                  setChartRange,
                  (value) => t(CHART_RANGE_KEYS[value]),
                  t("usage.range"),
                )}
                <div className="ml-auto" />
                {chips(
                  ["bars", "line"] as const,
                  chartKind,
                  setChartKind,
                  (value) =>
                    value === "bars"
                      ? t("usage.kindBars")
                      : t("usage.kindLine"),
                  t("usage.trend"),
                )}
              </>,
              <TrendChart
                trend={trend}
                kind={chartKind}
                peakLabel={t("usage.trend")}
              />,
            )}

            {card(
              t("usage.heatmap"),
              <span className="text-[9.5px] text-muted-foreground">
                {t("usage.heatmapWeeks", { count: HEATMAP_WEEKS })}
              </span>,
              <Heatmap
                cells={heatmap.cells}
                weeks={heatmap.weeks}
                labels={{
                  less: t("usage.heatLess"),
                  more: t("usage.heatMore"),
                  scale: t("usage.heatScale"),
                  none: t("usage.heatNone"),
                }}
              />,
            )}

            {/* Side by side only when there is room: at this window's width each card would be
                ~420px, and five numeric columns leave about a hundred for the name, which truncates
                every model id to "deepseek-...". Stacked, each table gets the full width. */}
            <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
              {card(
                t("usage.agent"),
                null,
                <div className="flex items-start gap-4">
                  <div className="min-w-0 flex-1">
                    <UsageTable
                      id="agent"
                      nameHeader={t("usage.colAgent")}
                      labels={{
                        total: t("usage.colTotal"),
                        input: t("usage.colInput"),
                        output: t("usage.colOutput"),
                        cacheRead: t("usage.colCacheRead"),
                        requests: t("usage.colRequests"),
                        share: t("usage.colShare"),
                      }}
                      rows={view.byTool}
                      nameOf={(row) => row.label}
                      iconOf={(row) => (
                        <AgentIcon agent={row.tool ?? row.label} size={12} />
                      )}
                      colorOf={(row) => agentColor(row.tool ?? row.label)}
                      emptyLabel={t("usage.empty")}
                      onPick={(row) => setTool(row.tool ?? null)}
                    />
                  </div>
                  <SharePie
                    slices={agentSlices}
                    caption={t("usage.colShare")}
                    unit={t("usage.unitTokens")}
                  />
                </div>,
              )}
              {card(
                t("usage.models"),
                <>
                  <span className="text-[9.5px] text-muted-foreground">
                    {view.byModel.length}
                  </span>
                  <span className="ml-auto flex items-center gap-1.5">
                    <span className="text-[9.5px] text-muted-foreground">
                      {t("usage.foldBelow")}
                    </span>
                  <span className="flex items-center gap-0.5 rounded-md bg-foreground/[0.05] p-0.5">
                    {FOLD_STEPS.map((step) => (
                      <button
                        key={step}
                        type="button"
                        data-usage-chip={`fold-${step}`}
                        aria-pressed={Math.abs(foldBelow - step / 100) < 1e-9}
                        onClick={() => setFoldBelow(step / 100)}
                        className={cn(
                          "cursor-pointer rounded px-1.5 py-0.5 text-[10px] tabular-nums outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-primary/40",
                          Math.abs(foldBelow - step / 100) < 1e-9
                            ? "bg-primary font-medium text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {step}%
                        </button>
                      ))}
                    </span>
                  </span>
                </>,
                
                <div className="flex items-start gap-4">
                  <div className="min-w-0 flex-1">
                    <UsageTable
                      id="models"
                      nameHeader={t("usage.colModel")}
                      labels={{
                        total: t("usage.colTotal"),
                        input: t("usage.colInput"),
                        output: t("usage.colOutput"),
                        cacheRead: t("usage.colCacheRead"),
                        requests: t("usage.colRequests"),
                        share: t("usage.colShare"),
                      }}
                      rows={view.byModel}
                      nameOf={(row) =>
                        row.other
                          ? t("usage.other")
                          : (row.model ?? t("usage.unnamedModel"))
                      }
                      // The provider a model ran through was a second line of small text under
                      // every row: it made the list hard to scan and answered a question nobody
                      // asked of it. The colour is the row's slice in the donut beside it.
                      noteOf={(row) =>
                        row.other
                          ? t("usage.foldedModels", { count: row.folded ?? 0 })
                          : null
                      }
                      colorOf={(row) =>
                        modelColorByKey.get(row.key) ?? modelSlices[0]?.color ?? ""
                      }
                      emptyLabel={t("usage.empty")}
                    />
                  </div>
                  <SharePie
                    slices={modelSlices}
                    caption={t("usage.colShare")}
                    unit={t("usage.unitTokens")}
                  />
                </div>,
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
