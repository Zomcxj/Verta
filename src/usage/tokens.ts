/**
 * The usage window's data layer: what a range, a tool filter and a token scope add up to.
 *
 * The command hands over one read - every day, with each day broken down by tool, provider and
 * model - and everything the window draws is a slice of it. That is deliberate: the read walks every
 * store on the machine (5.6 GB of opencode plus every transcript), so a range switch or a cache
 * switch must be arithmetic on what is already in memory, never another read. It also means the
 * day, the bars, the heatmap and the two tables can never disagree, because they are sums of the
 * same cells.
 */

/** Tokens one cell used, in the classes the tools themselves separate. */
export type UsageParts = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** A total the tool reported without a breakdown (pi's `totalTokens`, opencode's `total`). */
  unsplit: number;
};

/** Which token classes a number counts. */
export type TokenScope = {
  cacheRead: boolean;
  cacheWrite: boolean;
};

export type UsageCell = {
  tool: string;
  provider: string | null;
  model: string | null;
  parts: UsageParts;
  tokens: number;
  events: number;
};

export type UsageDay = {
  /** Days since 1970-01-01, in the payload's offset. */
  day: number;
  /** `YYYY-MM-DD`, from Rust, so this side never does date arithmetic on a bucket. */
  label: string;
  parts: UsageParts;
  tokens: number;
  events: number;
  /** Biggest first. */
  cells: UsageCell[];
};

export type UsagePayload = {
  sinceMs: number | null;
  offsetMinutes: number;
  scope: TokenScope;
  parts: UsageParts;
  tokens: number;
  events: number;
  excludedCacheRead: number;
  excludedCacheWrite: number;
  /** Oldest first. */
  days: UsageDay[];
  failures: string[];
};

/** The ranges the window offers. */
export type UsageRange = "today" | "week" | "month" | "all";
export const USAGE_RANGES: readonly UsageRange[] = [
  "today",
  "week",
  "month",
  "all",
];

/** The trend chart's own ranges, in days; `0` is everything. */
export const CHART_RANGES = [7, 30, 90, 365, 0] as const;
export type ChartRange = (typeof CHART_RANGES)[number];

export const EMPTY_PARTS: UsageParts = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  unsplit: 0,
};

export function addParts(left: UsageParts, right: UsageParts): UsageParts {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    unsplit: left.unsplit + right.unsplit,
  };
}

/**
 * How many tokens these parts are worth under this scope.
 *
 * Unsplit tokens are always counted: the tool reported them as spent, there is just nothing to
 * attribute them to. Cache reads and writes are the two that people argue about, so they are the
 * two the window offers a switch for.
 */
export function countTokens(parts: UsageParts, scope: TokenScope): number {
  let total = parts.input + parts.output + parts.reasoning + parts.unsplit;
  if (scope.cacheRead) total += parts.cacheRead;
  if (scope.cacheWrite) total += parts.cacheWrite;
  return total;
}

/** The offset a local day needs, in minutes east of UTC. */
export function localOffsetMinutes(at: Date = new Date()): number {
  // `getTimezoneOffset` is minutes *behind* UTC (UTC+8 gives -480), the opposite sign of what the
  // Rust side wants.
  return -at.getTimezoneOffset();
}

/** Which day an instant falls in, for an offset in minutes east of UTC. */
export function dayOf(atMs: number, offsetMinutes: number): number {
  return Math.floor((atMs + offsetMinutes * 60_000) / 86_400_000);
}

/** The calendar date of a day index, read off the shifted epoch as if it were UTC. */
export function dateOfDay(day: number): {
  year: number;
  month: number;
  date: number;
} {
  const date = new Date(day * 86_400_000);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    date: date.getUTCDate(),
  };
}

/** Monday = 0, which is the week the `week` range starts on. */
export function mondayIndex(day: number): number {
  // Day 0 (1970-01-01) was a Thursday, so Monday-of-week is day + 3, modulo 7.
  return (((day + 3) % 7) + 7) % 7;
}

/** The first day a range covers, given today's day index. */
export function rangeStartDay(range: UsageRange, today: number): number {
  switch (range) {
    case "today":
      return today;
    case "week":
      return today - mondayIndex(today);
    case "month": {
      const { year, month } = dateOfDay(today);
      return Math.round(Date.UTC(year, month - 1, 1) / 86_400_000);
    }
    case "all":
      return Number.NEGATIVE_INFINITY;
  }
}

/** One row of the tool or model table. */
export type UsageRow = {
  /** Stable identity for React and for sorting ties: `tool` or `provider/model`. */
  key: string;
  /** What the first column shows. */
  label: string;
  tool?: string;
  provider: string | null;
  model: string | null;
  parts: UsageParts;
  tokens: number;
  events: number;
  /** This row's share of the range total, 0..1. */
  share: number;
};

/** Everything the window draws for one range, one tool filter and one scope. */
export type UsageView = {
  /** The days the range covers, oldest first, empty days dropped. */
  days: UsageDay[];
  parts: UsageParts;
  tokens: number;
  events: number;
  activeDays: number;
  /** Tokens per active day (a day that used anything), not per calendar day. */
  perDay: number;
  peak: { day: number; label: string; tokens: number } | null;
  favourite: UsageRow | null;
  byTool: UsageRow[];
  byModel: UsageRow[];
  /** Consecutive days up to today (or yesterday, if today is still empty) with any usage. */
  streak: number;
  /** This range's share of everything on the machine, or `null` for the `all` range. */
  shareOfAll: number | null;
};

/** Sum the cells that pass the filter, so a range is a filter and never a second read. */
export function buildView(
  payload: UsagePayload,
  options: {
    range: UsageRange;
    tool: string | null;
    scope: TokenScope;
    today: number;
  },
): UsageView {
  const { range, tool, scope, today } = options;
  const start = rangeStartDay(range, today);
  const days = payload.days.filter(
    (day) => day.day >= start && (tool === null || dayHasTool(day, tool)),
  );

  let parts = EMPTY_PARTS;
  let events = 0;
  let activeDays = 0;
  let peak: UsageView["peak"] = null;
  const byTool = new Map<string, UsageRow>();
  const byModel = new Map<string, UsageRow>();
  for (const day of days) {
    const cells =
      tool === null ? day.cells : day.cells.filter((c) => c.tool === tool);
    let dayParts = EMPTY_PARTS;
    let dayEvents = 0;
    for (const cell of cells) {
      dayParts = addParts(dayParts, cell.parts);
      dayEvents += cell.events;
      // A cell that is worth nothing under this scope (a synthetic message, or one whose only
      // tokens were cache reads with that switch off) adds no row: `0.0%` rows are noise. It still
      // contributes its parts, so the day and the total stay sums of the same cells.
      const value = countTokens(cell.parts, scope);
      if (value <= 0) continue;
      // Attribution is summed from the same cells as everything else: a tool row and a model row
      // both reach the same total because no cell is counted twice or skipped.
      const toolRow = byTool.get(cell.tool) ?? {
        key: cell.tool,
        label: cell.tool,
        tool: cell.tool,
        provider: null,
        model: null,
        parts: EMPTY_PARTS,
        tokens: 0,
        events: 0,
        share: 0,
      };
      toolRow.parts = addParts(toolRow.parts, cell.parts);
      toolRow.tokens += value;
      toolRow.events += cell.events;
      byTool.set(cell.tool, toolRow);

      const modelKey = `${cell.provider ?? ""}/${cell.model ?? ""}`;
      const modelRow = byModel.get(modelKey) ?? {
        key: modelKey,
        label: cell.model ?? "",
        provider: cell.provider,
        model: cell.model,
        parts: EMPTY_PARTS,
        tokens: 0,
        events: 0,
        share: 0,
      };
      modelRow.parts = addParts(modelRow.parts, cell.parts);
      modelRow.tokens += value;
      modelRow.events += cell.events;
      byModel.set(modelKey, modelRow);
    }
    parts = addParts(parts, dayParts);
    events += dayEvents;
    const dayTokens = countTokens(dayParts, scope);
    if (dayTokens > 0) {
      activeDays += 1;
      if (peak === null || dayTokens > peak.tokens) {
        peak = { day: day.day, label: day.label, tokens: dayTokens };
      }
    }
  }

  const tokens = countTokens(parts, scope);
  const rows = (map: Map<string, UsageRow>): UsageRow[] => {
    const list = [...map.values()];
    for (const row of list) row.share = tokens > 0 ? row.tokens / tokens : 0;
    list.sort(
      (left, right) =>
        right.tokens - left.tokens || left.label.localeCompare(right.label),
    );
    return list;
  };
  const tools = rows(byTool);
  const models = rows(byModel);

  return {
    days,
    parts,
    tokens,
    events,
    activeDays,
    perDay: activeDays > 0 ? tokens / activeDays : 0,
    peak,
    favourite: models[0] ?? null,
    byTool: tools,
    byModel: models,
    streak: streakOf(payload.days, scope, tool, today),
    shareOfAll:
      range === "all"
        ? null
        : ratioOf(tokens, countTokens(payload.parts, scope)),
  };
}

function dayHasTool(day: UsageDay, tool: string): boolean {
  return day.cells.some((cell) => cell.tool === tool);
}

/**
 * Consecutive days with usage, counted back from today.
 *
 * Today not having any yet must not read as "the streak ended yesterday", so the walk starts at
 * today when it has usage and at yesterday when it does not; the first gap after that ends it.
 */
export function streakOf(
  days: UsageDay[],
  scope: TokenScope,
  tool: string | null,
  today: number,
): number {
  const totals = new Map<number, number>();
  for (const day of days) {
    const cells =
      tool === null ? day.cells : day.cells.filter((c) => c.tool === tool);
    let parts = EMPTY_PARTS;
    for (const cell of cells) parts = addParts(parts, cell.parts);
    const tokens = countTokens(parts, scope);
    if (tokens > 0) totals.set(day.day, tokens);
  }
  let day = totals.has(today) ? today : today - 1;
  let streak = 0;
  while (totals.has(day)) {
    streak += 1;
    day -= 1;
  }
  return streak;
}

/** `part / whole` as a fraction, or `null` when the whole is not positive. */
export function ratioOf(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** One column of the trend chart: a day, and one value per series. */
export type TrendColumn = {
  day: number;
  label: string;
  values: number[];
  total: number;
};

/** The chart's answer: the columns, and the series that stack into them. */
export type TrendSeries = {
  /** The model's `provider/model`, the "other" bucket's own key, and the label to draw. */
  key: string;
  label: string;
  provider: string | null;
  model: string | null;
  total: number;
  /** One value per column, in column order. */
  values: number[];
};

export type Trend = {
  columns: TrendColumn[];
  series: TrendSeries[];
  /** The biggest single-day total in the window, drawn in the legend of the line mode. */
  peak: number;
};

/** How many models the chart draws before folding the tail into one bucket. */
export const MAX_SERIES = 6;
export const OTHER_SERIES_KEY = "__other__";

/**
 * The trend chart's data: the last `range` days, stacked by model, with the tail folded.
 *
 * Folding by model (rather than by cell) is what makes the stack readable: a tool that used the
 * same model on the same day is one bar segment either way, and the number of colours stays at
 * `MAX_SERIES + 1` no matter how many models the history contains.
 */
export function buildTrend(
  payload: UsagePayload,
  options: {
    range: ChartRange;
    tool: string | null;
    scope: TokenScope;
    today: number;
    otherLabel: string;
  },
): Trend {
  const { range, tool, scope, today, otherLabel } = options;
  const start = range === 0 ? Number.NEGATIVE_INFINITY : today - range + 1;
  const byDay = new Map<number, Map<string, number>>();
  const totals = new Map<
    string,
    { provider: string | null; model: string | null; total: number }
  >();
  for (const day of payload.days) {
    if (day.day < start || day.day > today) continue;
    const cells =
      tool === null ? day.cells : day.cells.filter((c) => c.tool === tool);
    if (cells.length === 0) continue;
    const bucket = byDay.get(day.day) ?? new Map<string, number>();
    for (const cell of cells) {
      const key = `${cell.provider ?? ""}/${cell.model ?? ""}`;
      const value = countTokens(cell.parts, scope);
      if (value <= 0) continue;
      bucket.set(key, (bucket.get(key) ?? 0) + value);
      const entry = totals.get(key) ?? {
        provider: cell.provider,
        model: cell.model,
        total: 0,
      };
      entry.total += value;
      totals.set(key, entry);
    }
    byDay.set(day.day, bucket);
  }

  const ranked = [...totals.entries()].sort(
    ([leftKey, left], [rightKey, right]) =>
      right.total - left.total || leftKey.localeCompare(rightKey),
  );
  const kept = ranked.slice(0, MAX_SERIES);
  const folded = ranked.slice(MAX_SERIES);
  const foldedKeys = new Set(folded.map(([key]) => key));

  // The full day sequence, so a gap in the history is a gap in the chart rather than two days
  // drawn next to each other as if nothing happened in between.
  const first = range === 0 ? minDay(payload.days) : start;
  const columns: TrendColumn[] = [];
  if (first !== null && first <= today) {
    for (let day = Math.max(first, start); day <= today; day += 1) {
      const bucket = byDay.get(day);
      const values = kept.map(([key]) => bucket?.get(key) ?? 0);
      if (folded.length > 0) {
        let other = 0;
        for (const key of foldedKeys) other += bucket?.get(key) ?? 0;
        values.push(other);
      }
      columns.push({
        day,
        label: labelOfDay(day),
        values,
        total: values.reduce((sum, value) => sum + value, 0),
      });
    }
  }

  const series: TrendSeries[] = kept.map(([key, entry], index) => ({
    key,
    label: entry.model ?? "—",
    provider: entry.provider,
    model: entry.model,
    total: entry.total,
    values: columns.map((column) => column.values[index] ?? 0),
  }));
  if (folded.length > 0) {
    series.push({
      key: OTHER_SERIES_KEY,
      label: otherLabel,
      provider: null,
      model: null,
      total: folded.reduce((sum, [, entry]) => sum + entry.total, 0),
      values: columns.map((column) => column.values[kept.length] ?? 0),
    });
  }

  return {
    columns,
    series,
    peak: columns.reduce((max, column) => Math.max(max, column.total), 0),
  };
}

function minDay(days: UsageDay[]): number | null {
  return days.length > 0 ? days[0].day : null;
}

/** `YYYY-MM-DD` for a day index, the inverse of `dayOf` (the index is already offset-shifted). */
export function labelOfDay(day: number): string {
  const { year, month, date } = dateOfDay(day);
  return `${year}-${`${month}`.padStart(2, "0")}-${`${date}`.padStart(2, "0")}`;
}

/** `M/D`, the axis and tooltip label: no year, no zero padding. */
export function shortLabel(label: string): string {
  const [, month, day] = label.split("-");
  if (month === undefined || day === undefined) return label;
  return `${Number(month)}/${Number(day)}`;
}

/**
 * The heatmap's levels: four buckets cut at the quartiles of the non-zero day totals.
 *
 * Quantiles rather than fixed thresholds because usage ranges over three orders of magnitude on one
 * machine, and a fixed scale would paint every cell either empty or black. Strictly increasing
 * thresholds, because duplicate cuts would make a level unreachable.
 */
export type HeatCell = {
  day: number;
  label: string;
  tokens: number;
  /** 0 is "no usage"; 1..4 are the quartiles. */
  level: number;
  /** Whether the day is inside the loaded history at all (a future day is not). */
  known: boolean;
};

export function buildHeatmap(
  payload: UsagePayload,
  options: {
    tool: string | null;
    scope: TokenScope;
    today: number;
    weeks: number;
  },
): { cells: HeatCell[]; weeks: number } {
  const { tool, scope, today, weeks } = options;
  const totals = new Map<number, number>();
  for (const day of payload.days) {
    const cells =
      tool === null ? day.cells : day.cells.filter((c) => c.tool === tool);
    let parts = EMPTY_PARTS;
    for (const cell of cells) parts = addParts(parts, cell.parts);
    const tokens = countTokens(parts, scope);
    if (tokens > 0) totals.set(day.day, tokens);
  }
  const thresholds = quantiles([...totals.values()], [0.25, 0.5, 0.75]);
  // Monday-first columns, ending on the week today is in; the tail of that last week is in the
  // future and is drawn as an empty cell rather than as a day that used nothing.
  const firstDay = today - mondayIndex(today) - (weeks - 1) * 7;
  const cells: HeatCell[] = [];
  for (let index = 0; index < weeks * 7; index += 1) {
    const day = firstDay + index;
    const tokens = day <= today ? (totals.get(day) ?? 0) : 0;
    cells.push({
      day,
      label: labelOfDay(day),
      tokens,
      level: day <= today ? levelOf(tokens, thresholds) : 0,
      known: day <= today,
    });
  }
  return { cells, weeks };
}

function levelOf(tokens: number, thresholds: number[]): number {
  if (tokens <= 0) return 0;
  let level = 1;
  for (const threshold of thresholds) if (tokens > threshold) level += 1;
  return Math.min(level, 4);
}

/** Nearest-rank quantiles of a sample, made strictly increasing. */
export function quantiles(values: number[], cuts: number[]): number[] {
  const sorted = [...values].sort((left, right) => left - right);
  const out: number[] = [];
  for (const cut of cuts) {
    if (sorted.length === 0) {
      out.push(0);
      continue;
    }
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(cut * sorted.length) - 1),
    );
    let value = sorted[index];
    if (out.length > 0) value = Math.max(value, out[out.length - 1] + 1);
    out.push(value);
  }
  return out;
}

/** `561,023,456`: the headline number, with separators. */
export function fullTokens(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(Math.round(value));
}

/**
 * `45.6M`, `1.2K`, `12B`: magnitude first, one decimal.
 *
 * One decimal even above ten, because these numbers are read against each other in a column and
 * `46M` next to `45.6M` hides a real difference.
 */
export function compactTokens(value: number): string {
  const abs = Math.abs(value);
  const scale = (divisor: number, suffix: string) => {
    const text = (value / divisor).toFixed(1).replace(/\.0$/, "");
    return `${text}${suffix}`;
  };
  if (abs >= 1_000_000_000) return scale(1_000_000_000, "B");
  if (abs >= 1_000_000) return scale(1_000_000, "M");
  if (abs >= 1_000) return scale(1_000, "K");
  return `${Math.round(value)}`;
}

/**
 * `12.3%`, `<0.1%` or `—`.
 *
 * `—` when there is nothing to divide by, and `<0.1%` for a part that is real but rounds to zero,
 * so a non-zero row never reads as "0.0%".
 */
export function percentText(part: number, whole: number): string {
  if (whole <= 0) return "—";
  const value = (part / whole) * 100;
  if (value > 0 && value < 0.1) return "<0.1%";
  return `${value.toFixed(1)}%`;
}
