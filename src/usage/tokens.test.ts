import { describe, expect, it } from "vitest";
import {
  buildHeatmap,
  buildTrend,
  buildView,
  compactTokens,
  countTokens,
  dayOf,
  labelOfDay,
  localOffsetMinutes,
  MAX_SERIES,
  mondayIndex,
  OTHER_SERIES_KEY,
  foldTail,
  isToolAvailable,
  modelIdentity,
  OTHER_KEY,
  percentText,
  quantiles,
  rangeStartDay,
  type UsageCell,
  type UsageDay,
  type UsageParts,
  type UsagePayload,
} from "./tokens";

const parts = (patch: Partial<UsageParts> = {}): UsageParts => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  unsplit: 0,
  ...patch,
});

const cell = (
  tool: string,
  provider: string | null,
  model: string | null,
  value: Partial<UsageParts>,
): UsageCell => {
  const filled = parts(value);
  return {
    tool,
    provider,
    model,
    parts: filled,
    tokens: countTokens(filled, { cacheRead: true, cacheWrite: true }),
    events: 1,
  };
};

/** 2026-11-13 as a day index, so the fixtures read as dates. */
const BASE = Math.round(Date.UTC(2026, 10, 13) / 86_400_000);

const day = (offset: number, cells: UsageCell[]): UsageDay => {
  let total = parts();
  let tokens = 0;
  let events = 0;
  for (const entry of cells) {
    total = {
      input: total.input + entry.parts.input,
      output: total.output + entry.parts.output,
      reasoning: total.reasoning + entry.parts.reasoning,
      cacheRead: total.cacheRead + entry.parts.cacheRead,
      cacheWrite: total.cacheWrite + entry.parts.cacheWrite,
      unsplit: total.unsplit + entry.parts.unsplit,
    };
    tokens += entry.tokens;
    events += entry.events;
  }
  const index = BASE + offset;
  return {
    day: index,
    label: labelOfDay(index),
    parts: total,
    tokens,
    events,
    cells,
  };
};

const payload = (days: UsageDay[]): UsagePayload => {
  let total = parts();
  let tokens = 0;
  let events = 0;
  for (const entry of days) {
    total = {
      input: total.input + entry.parts.input,
      output: total.output + entry.parts.output,
      reasoning: total.reasoning + entry.parts.reasoning,
      cacheRead: total.cacheRead + entry.parts.cacheRead,
      cacheWrite: total.cacheWrite + entry.parts.cacheWrite,
      unsplit: total.unsplit + entry.parts.unsplit,
    };
    tokens += entry.tokens;
    events += entry.events;
  }
  return {
    sinceMs: null,
    offsetMinutes: 0,
    scope: { cacheRead: true, cacheWrite: true },
    parts: total,
    tokens,
    events,
    excludedCacheRead: 0,
    excludedCacheWrite: 0,
    days,
    failures: [],
  };
};

const both = { cacheRead: true, cacheWrite: true };
const withoutCache = { cacheRead: false, cacheWrite: false };
const today = BASE + 2;

const fixture = payload([
  day(0, [
    cell("claude", null, "claude-sonnet-4-5", {
      input: 10,
      output: 2,
      cacheRead: 100,
    }),
    cell("opencode", "workbuddy", "glm-5.3-flash", {
      input: 100,
      output: 20,
      cacheRead: 900,
    }),
  ]),
  day(1, [cell("pi", "openai_agentrouter", "gpt-5.6-sol", { unsplit: 50 })]),
  day(2, [
    cell("opencode", "workbuddy", "glm-5.3-flash", { input: 5, cacheRead: 40 }),
  ]),
]);

describe("countTokens", () => {
  // The same table Rust's `the_same_events_answer_differently_under_different_scopes` pins, so the
  // two implementations are checked against the same numbers rather than against each other.
  const sample = parts({
    input: 100,
    output: 20,
    cacheRead: 900,
    cacheWrite: 80,
  });

  it("counts everything under the full scope", () => {
    expect(countTokens(sample, both)).toBe(1_100);
  });

  it("drops cache reads and writes when both switches are off", () => {
    expect(countTokens(sample, withoutCache)).toBe(120);
  });

  it("keeps one cache class when only the other switch is off", () => {
    expect(countTokens(sample, { cacheRead: true, cacheWrite: false })).toBe(
      1_020,
    );
    expect(countTokens(sample, { cacheRead: false, cacheWrite: true })).toBe(
      200,
    );
  });

  it("always counts tokens a tool did not split, and reasoning, which opencode reports apart", () => {
    expect(countTokens(parts({ unsplit: 250 }), withoutCache)).toBe(250);
    expect(countTokens(parts({ reasoning: 7 }), withoutCache)).toBe(7);
  });
});

describe("days and ranges", () => {
  it("derives the offset as minutes east of UTC, which is the sign Rust wants", () => {
    const shanghai = { getTimezoneOffset: () => -480 } as unknown as Date;
    expect(localOffsetMinutes(shanghai)).toBe(480);
    const newYork = { getTimezoneOffset: () => 300 } as unknown as Date;
    expect(localOffsetMinutes(newYork)).toBe(-300);
  });

  it("labels a day index the way the readers key it", () => {
    expect(labelOfDay(BASE)).toBe("2026-11-13");
    expect(dayOf(Date.UTC(2026, 10, 13, 12), 0)).toBe(BASE);
    // UTC+8 pushes a late-evening instant into the next local day.
    expect(dayOf(Date.UTC(2026, 10, 13, 23, 30), 480)).toBe(BASE + 1);
  });

  it("starts a week on Monday", () => {
    // 2026-11-13 is a Friday.
    expect(mondayIndex(BASE)).toBe(4);
    expect(rangeStartDay("week", BASE)).toBe(BASE - 4);
    expect(rangeStartDay("today", BASE)).toBe(BASE);
    expect(rangeStartDay("month", BASE)).toBe(
      Math.round(Date.UTC(2026, 10, 1) / 86_400_000),
    );
    expect(rangeStartDay("all", BASE)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("buildView", () => {
  it("counts a model once, however many providers answered for it", () => {
    const split = payload([
      day(0, [
        cell("workbuddy", "workbuddy", "deepseek-v4.1-flash", { input: 60 }),
        cell("opencode", "openai", "deepseek-v4.1-flash", { input: 40 }),
      ]),
    ]);
    const view = buildView(split, {
      range: "all",
      tool: null,
      scope: both,
      today,
    });
    // The provider used to be a line of small text under each model name, and that line was the
    // only thing telling two rows apart. With it gone, two rows that both read
    // "deepseek-v4.1-flash" with different totals look like a bug, so the table is by model.
    expect(view.byModel).toHaveLength(1);
    expect(view.byModel[0]?.key).toBe("deepseek-v4.1-flash");
    expect(view.byModel[0]?.tokens).toBe(100);
    expect(view.byModel[0]?.provider).toBeNull();
    // The chart keeps them apart: there a series is a provider and a model.
    const trend = buildTrend(split, {
      range: 7,
      tool: null,
      scope: both,
      today,
      otherLabel: "other",
    });
    expect(trend.series).toHaveLength(2);
  });

  it("files a model under its id, not under the agent's spelling of it", () => {
    // The four spellings this machine really has: one model through a local provider, one through a
    // routing tag, one with the repository in front, and one the agent re-cased.
    expect(modelIdentity("custom-local:deepseek-v4.1-flash")).toEqual({
      key: "deepseek-v4.1-flash",
      name: "deepseek-v4.1-flash",
    });
    expect(modelIdentity("[次]deepseek-v4-flash")).toEqual({
      key: "deepseek-v4-flash",
      name: "deepseek-v4-flash",
    });
    expect(modelIdentity("Qwen/Qwen3-8B")).toEqual({
      key: "qwen3-8b",
      name: "Qwen3-8B",
    });
    expect(modelIdentity("GLM-5.3-Flash").key).toBe("glm-5.3-flash");
    expect(modelIdentity(null)).toEqual({ key: "", name: null });
    expect(modelIdentity("   ")).toEqual({ key: "", name: null });
  });

  it("shows the spelling that carried the most tokens", () => {
    const view = buildView(
      payload([
        day(0, [
          cell("zcode", "workbuddy", "GLM-5.3-Flash", { input: 20 }),
          cell("opencode", "openai", "glm-5.3-flash", { input: 80 }),
          cell("workbuddy", null, "custom-local:glm-5.3-flash", { input: 5 }),
        ]),
      ]),
      { range: "all", tool: null, scope: both, today },
    );
    expect(view.byModel).toHaveLength(1);
    expect(view.byModel[0]?.tokens).toBe(105);
    expect(view.byModel[0]?.label).toBe("glm-5.3-flash");
    expect(view.byModel[0]?.model).toBe("glm-5.3-flash");
  });

  it("sums the cells, and both attributions reach the same total", () => {
    const view = buildView(fixture, {
      range: "all",
      tool: null,
      scope: both,
      today,
    });
    expect(view.tokens).toBe(10 + 2 + 100 + 100 + 20 + 900 + 50 + 5 + 40);
    expect(view.events).toBe(4);
    const byTool = view.byTool.reduce((sum, row) => sum + row.tokens, 0);
    const byModel = view.byModel.reduce((sum, row) => sum + row.tokens, 0);
    expect(byTool).toBe(view.tokens);
    expect(byModel).toBe(view.tokens);
    // Biggest first, and the share is of the range total.
    expect(view.byTool[0].label).toBe("opencode");
    expect(view.byTool[0].share).toBeCloseTo(
      (100 + 20 + 900 + 5 + 40) / view.tokens,
      6,
    );
  });

  it("counts active days and the peak, and the peak is the day that is drawn tallest", () => {
    const view = buildView(fixture, {
      range: "all",
      tool: null,
      scope: both,
      today,
    });
    expect(view.activeDays).toBe(3);
    expect(view.peak?.day).toBe(BASE);
    expect(view.peak?.tokens).toBe(1_132);
    expect(view.perDay).toBeCloseTo(view.tokens / 3, 6);
    expect(view.favourite?.model).toBe("glm-5.3-flash");
  });

  it("narrows to a range without a second read, and says what share of everything it is", () => {
    const all = buildView(fixture, {
      range: "all",
      tool: null,
      scope: both,
      today,
    });
    const todayOnly = buildView(fixture, {
      range: "today",
      tool: null,
      scope: both,
      today,
    });
    expect(todayOnly.days).toHaveLength(1);
    expect(todayOnly.tokens).toBe(45);
    expect(todayOnly.shareOfAll).toBeCloseTo(45 / all.tokens, 6);
    // The `all` range has nothing bigger to be a share of.
    expect(all.shareOfAll).toBeNull();
  });

  it("filters by tool", () => {
    const view = buildView(fixture, {
      range: "all",
      tool: "pi",
      scope: both,
      today,
    });
    expect(view.tokens).toBe(50);
    expect(view.byTool.map((row) => row.label)).toEqual(["pi"]);
    expect(view.days).toHaveLength(1);
  });

  it("re-sums the same cells under another scope", () => {
    const view = buildView(fixture, {
      range: "all",
      tool: null,
      scope: withoutCache,
      today,
    });
    expect(view.tokens).toBe(10 + 2 + 100 + 20 + 50 + 5);
    expect(view.byTool.find((row) => row.label === "claude")?.tokens).toBe(12);
  });

  it("measures a streak back from today, and does not end it because today is young", () => {
    expect(
      buildView(fixture, { range: "all", tool: null, scope: both, today })
        .streak,
    ).toBe(3);
    // A gap yesterday ends it after today's single day.
    const gapped = payload([
      day(0, [cell("pi", null, "m", { input: 1 })]),
      day(2, [cell("pi", null, "m", { input: 1 })]),
    ]);
    expect(
      buildView(gapped, { range: "all", tool: null, scope: both, today })
        .streak,
    ).toBe(1);
    // Nothing today yet, but yesterday: still a streak, counted from yesterday.
    const yesterdayOnly = payload([
      day(1, [cell("pi", null, "m", { input: 1 })]),
    ]);
    expect(
      buildView(yesterdayOnly, { range: "all", tool: null, scope: both, today })
        .streak,
    ).toBe(1);
  });
});

describe("buildTrend", () => {
  const many = payload(
    Array.from({ length: MAX_SERIES + 3 }, (_, index) =>
      day(0, [
        cell("opencode", "p", `model-${index}`, {
          input: (MAX_SERIES + 3 - index) * 10,
        }),
      ]),
    ),
  );

  it("folds everything past the first few models into one bucket", () => {
    const trend = buildTrend(many, {
      range: 7,
      tool: null,
      scope: both,
      today: BASE,
      otherLabel: "Other",
    });
    expect(trend.series).toHaveLength(MAX_SERIES + 1);
    expect(trend.series[MAX_SERIES].key).toBe(OTHER_SERIES_KEY);
    expect(trend.series[MAX_SERIES].label).toBe("Other");
    // Nothing is lost by folding: the series still add up to the columns.
    const seriesTotal = trend.series.reduce(
      (sum, entry) => sum + entry.total,
      0,
    );
    const columnTotal = trend.columns.reduce(
      (sum, column) => sum + column.total,
      0,
    );
    expect(seriesTotal).toBe(columnTotal);
  });

  it("draws a day for every day in the window, so a gap is a gap", () => {
    const trend = buildTrend(fixture, {
      range: 7,
      tool: null,
      scope: both,
      today,
      otherLabel: "Other",
    });
    expect(trend.columns).toHaveLength(7);
    expect(trend.columns[trend.columns.length - 1].day).toBe(today);
    // The four days before the fixture started have no usage at all.
    expect(
      trend.columns.slice(0, 4).every((column) => column.total === 0),
    ).toBe(true);
    expect(trend.peak).toBe(1_132);
  });

  it("starts at the first day that has data when the window is everything", () => {
    const trend = buildTrend(fixture, {
      range: 0,
      tool: null,
      scope: both,
      today,
      otherLabel: "Other",
    });
    expect(trend.columns).toHaveLength(3);
    expect(trend.columns[0].day).toBe(BASE);
  });
});

describe("buildHeatmap", () => {
  it("paints 53 weeks of cells, Monday first, and leaves the future empty", () => {
    const heat = buildHeatmap(fixture, {
      tool: null,
      scope: both,
      today,
      weeks: 53,
    });
    expect(heat.cells).toHaveLength(53 * 7);
    expect(mondayIndex(heat.cells[0].day)).toBe(0);
    const last = heat.cells[heat.cells.length - 1];
    expect(last.day).toBe(today - mondayIndex(today) + 6);
    // The tail of the current week is in the future: drawn, but as "not yet" rather than "nothing".
    expect(
      heat.cells
        .filter((entry) => entry.day > today)
        .every((entry) => !entry.known),
    ).toBe(true);
    expect(
      heat.cells
        .filter((entry) => entry.day <= today)
        .every((entry) => entry.known),
    ).toBe(true);
    const painted = heat.cells.filter((entry) => entry.level > 0);
    expect(painted.map((entry) => entry.day)).toEqual([
      BASE,
      BASE + 1,
      BASE + 2,
    ]);
  });

  it("cuts the levels at the quartiles of the days that used anything", () => {
    // 1, 2, 3, 4 tokens: the quartiles are 1, 2 and 3, so every day lands on its own level.
    const days = [1, 2, 3, 4].map((value, index) =>
      day(index - 3, [cell("pi", null, "m", { input: value })]),
    );
    const heat = buildHeatmap(payload(days), {
      tool: null,
      scope: both,
      today,
      weeks: 1,
    });
    const levels = heat.cells
      .filter((entry) => entry.tokens > 0)
      .map((entry) => `${entry.tokens}:${entry.level}`);
    expect(levels).toEqual(["1:1", "2:2", "3:3", "4:4"]);
    expect(quantiles([1, 2, 3, 4], [0.25, 0.5, 0.75])).toEqual([1, 2, 3]);
    // Duplicate cuts are pushed apart rather than leaving a level unreachable.
    expect(quantiles([5, 5, 5, 5], [0.25, 0.5, 0.75])).toEqual([5, 6, 7]);
  });
});

describe("folding the model tail", () => {
  const range = () =>
    payload([
      day(-1, [
        cell("opencode", null, "big", { input: 900 }),
        cell("opencode", null, "mid", { input: 90 }),
        cell("opencode", null, "tiny-a", { input: 6 }),
        cell("opencode", null, "tiny-b", { input: 4 }),
      ]),
    ]);

  it("sums the rows below the share into one, and keeps every token", () => {
    const data = range();
    const folded = buildView(data, {
      range: "all",
      tool: null,
      scope: both,
      today: BASE,
      foldBelow: 0.01,
    });
    // 900 + 90 + 6 + 4; anything under 1% of 1000 (10) is folded. The folded row carries no label:
    // the window names it in the user's language.
    expect(folded.byModel.map((row) => row.label)).toEqual(["big", "mid", ""]);
    expect(folded.byModel[folded.byModel.length - 1]?.key).toBe(OTHER_KEY);
    const other = folded.byModel.find((row) => row.other);
    expect(other?.tokens).toBe(10);
    expect(other?.folded).toBe(2);
    expect(folded.byModel.reduce((sum, row) => sum + row.tokens, 0)).toBe(1000);
    expect(folded.tokens).toBe(1000);
  });

  it("keeps the favourite before the fold, so it is never the folded row", () => {
    const data = payload([
      day(-1, [
        cell("opencode", null, "a", { input: 60 }),
        cell("opencode", null, "b", { input: 40 }),
      ]),
    ]);
    const folded = buildView(data, {
      range: "all",
      tool: null,
      scope: both,
      today: BASE,
      foldBelow: 0.5,
    });
    // 60% survives a 50% threshold, 40% does not.
    expect(folded.byModel).toHaveLength(2);
    expect(folded.byModel[1]?.other).toBe(true);
    expect(folded.byModel[1]?.folded).toBe(1);
    expect(folded.favourite?.label).toBe("a");
  });

  it("keeps every row at zero, which is what the summary and the chart read", () => {
    const data = range();
    const unfolded = buildView(data, {
      range: "all",
      tool: null,
      scope: both,
      today: BASE,
    });
    expect(unfolded.byModel).toHaveLength(4);
    expect(unfolded.byModel.some((row) => row.other)).toBe(false);
  });

  it("folds nothing when nothing is below the threshold", () => {
    const rows = [
      { share: 0.6 },
      { share: 0.4 },
    ].map(({ share }) => ({
      key: "k",
      label: "l",
      provider: null,
      model: null,
      parts: parts(),
      tokens: 0,
      events: 0,
      share,
    }));
    const kept = foldTail(rows, 0.01);
    expect(kept).toHaveLength(2);
    expect(kept.some((row) => row.other)).toBe(false);
  });
});

describe("which agents can be filtered to", () => {
  it("offers a tool the machine has a store for, and not one it does not", () => {
    const available = ["opencode", "pi"];
    expect(isToolAvailable(available, "opencode")).toBe(true);
    expect(isToolAvailable(available, "dsh")).toBe(false);
  });

  it("always offers the neutral chip", () => {
    expect(isToolAvailable([], null)).toBe(true);
  });

  it("treats a payload without a list as everything available", () => {
    expect(isToolAvailable(undefined, "dsh")).toBe(true);
  });
});

describe("formatting", () => {
  it("folds magnitudes and keeps one decimal at most", () => {
    expect(compactTokens(999)).toBe("999");
    expect(compactTokens(1_200)).toBe("1.2K");
    expect(compactTokens(45_600_000)).toBe("45.6M");
    expect(compactTokens(3_363_262_139)).toBe("3.4B");
    expect(compactTokens(12_000_000_000)).toBe("12B");
  });

  it("never lets a real number read as zero", () => {
    expect(percentText(1, 3)).toBe("33.3%");
    expect(percentText(0, 3)).toBe("0.0%");
    expect(percentText(1, 100_000)).toBe("<0.1%");
    expect(percentText(1, 0)).toBe("—");
  });
});
