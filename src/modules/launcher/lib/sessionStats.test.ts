import { describe, expect, it } from "vitest";

import {
  lastTalkedDayLabel,
  statsLine,
  statsOf,
  tokensLabel,
  turnsLabel,
} from "./sessionStats";

const NOW = new Date(2026, 9, 22, 15, 30).getTime(); // 2026-10-22 15:30 local time

describe("turnsLabel", () => {
  it("shows the count, or a dash when the tool keeps none", () => {
    expect(turnsLabel(12)).toBe("12 轮");
    expect(turnsLabel(0)).toBe("0 轮");
    expect(turnsLabel(null)).toBe("—");
    expect(turnsLabel(undefined)).toBe("—");
  });
});

describe("tokensLabel", () => {
  it("keeps small numbers readable and folds big ones into K / M", () => {
    expect(tokensLabel(850)).toBe("850 tokens");
    expect(tokensLabel(9_999)).toBe("9999 tokens");
    expect(tokensLabel(12_340)).toBe("12.3K tokens");
    expect(tokensLabel(170_000)).toBe("170K tokens");
    expect(tokensLabel(2_345_000)).toBe("2.3 M tokens");
    expect(tokensLabel(234_000_000)).toBe("234 M tokens");
  });

  it("reads one language the same way as the other", () => {
    // The unit is the unit: 170,000 tokens is 170K tokens whichever language the row is drawn in.
    expect(tokensLabel(170_000, "en")).toBe("170K tokens");
  });

  it("a session without usage data says so instead of claiming zero", () => {
    expect(tokensLabel(null)).toBe("—");
    expect(tokensLabel(undefined)).toBe("—");
  });
});

describe("lastTalkedDayLabel", () => {
  it("gets finer the closer it is: minutes, then hours", () => {
    expect(lastTalkedDayLabel(NOW, NOW - 5_000)).toBe("刚刚");
    expect(lastTalkedDayLabel(NOW, NOW - 40_000)).toBe("刚刚");
    expect(lastTalkedDayLabel(NOW, NOW - 12 * 60_000)).toBe("12 分钟前");
    expect(lastTalkedDayLabel(NOW, NOW - 59 * 60_000)).toBe("59 分钟前");
    // Hours snap to 1 / 3 / 6 / 12 so the numbers on one screen stay comparable.
    expect(lastTalkedDayLabel(NOW, NOW - 70 * 60_000)).toBe("1 小时前");
    expect(lastTalkedDayLabel(NOW, NOW - 3 * 3_600_000)).toBe("3 小时前");
    expect(lastTalkedDayLabel(NOW, NOW - 4_600_000)).toBe("1 小时前");
    expect(lastTalkedDayLabel(NOW, NOW - 5 * 3_600_000)).toBe("6 小时前");
    expect(lastTalkedDayLabel(NOW, NOW - 11 * 3_600_000)).toBe("12 小时前");
  });

  it("crosses into 昨天 / 前天 by calendar day, not by elapsed hours", () => {
    // NOW is 15:30; twenty hours earlier is 19:30 the previous day.
    expect(lastTalkedDayLabel(NOW, NOW - 20 * 3_600_000)).toBe("昨天");
    expect(
      lastTalkedDayLabel(NOW, new Date(2026, 9, 20, 23, 0).getTime()),
    ).toBe("前天");
  });

  it("falls back to a plain date a few days back", () => {
    expect(lastTalkedDayLabel(NOW, new Date(2026, 9, 8, 9, 0).getTime())).toBe(
      "2026-10-08",
    );
  });

  it("never shows a negative day when the clock jumped backwards", () => {
    expect(lastTalkedDayLabel(NOW, NOW + 5 * 86_400_000)).toBe("刚刚");
  });

  it("no time at all is a dash", () => {
    expect(lastTalkedDayLabel(NOW, null)).toBe("—");
    expect(lastTalkedDayLabel(NOW, 0)).toBe("—");
  });
});

describe("statsLine", () => {
  it("says the same three things the row says, in one line", () => {
    expect(
      statsLine({ turns: 12, tokens: 12_340, lastAtMs: NOW - 20 * 3_600_000 }, NOW),
    ).toBe("12 轮 · 12.3K tokens · 昨天");
  });

  it("reads the other language the same way, unit for unit", () => {
    expect(
      statsLine(
        { turns: 12, tokens: 12_340, lastAtMs: NOW - 20 * 3_600_000 },
        NOW,
        "en",
      ),
    ).toBe("12 turns · 12.3K tokens · Yesterday");
  });

  it("a session with nothing known says so with dashes, not zeros", () => {
    expect(statsLine({ turns: null, tokens: null, lastAtMs: null }, NOW)).toBe(
      "— · — · —",
    );
  });
});

describe("statsOf", () => {
  it("falls back to the file's update time when no message time is known", () => {
    expect(statsOf({ updatedAtMs: 1000 })).toEqual({
      turns: null,
      tokens: null,
      lastAtMs: 1000,
    });
    expect(statsOf({ turns: 3, tokens: 50, lastAtMs: 900, updatedAtMs: 1000 })).toEqual({
      turns: 3,
      tokens: 50,
      lastAtMs: 900,
    });
  });
});
