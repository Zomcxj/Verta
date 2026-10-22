import { describe, expect, it } from "vitest";

import {
  lastTalkedDayLabel,
  statsOf,
  tokensLabel,
  turnsLabel,
} from "./sessionStats";

const NOW = new Date(2026, 9, 22, 15, 30).getTime(); // 2026-10-22 15:30 本地时间

describe("turnsLabel", () => {
  it("shows the count, or a dash when the tool keeps none", () => {
    expect(turnsLabel(12)).toBe("12 轮");
    expect(turnsLabel(0)).toBe("0 轮");
    expect(turnsLabel(null)).toBe("—");
    expect(turnsLabel(undefined)).toBe("—");
  });
});

describe("tokensLabel", () => {
  it("keeps small numbers readable and folds big ones into 万 / M", () => {
    expect(tokensLabel(850)).toBe("850 tokens");
    expect(tokensLabel(9_999)).toBe("9999 tokens");
    expect(tokensLabel(12_340)).toBe("1.2 万 tokens");
    expect(tokensLabel(2_345_000)).toBe("2.3 M tokens");
    expect(tokensLabel(234_000_000)).toBe("234 M tokens");
  });

  it("a session without usage data says so instead of claiming zero", () => {
    expect(tokensLabel(null)).toBe("—");
    expect(tokensLabel(undefined)).toBe("—");
  });
});

describe("lastTalkedDayLabel", () => {
  it("says 今天 / 昨天 inside the last two days", () => {
    expect(lastTalkedDayLabel(NOW, NOW - 60_000)).toBe("今天");
    expect(lastTalkedDayLabel(NOW, NOW - 20 * 3600_000)).toBe("昨天");
  });

  it("falls back to a plain date a few days back", () => {
    expect(lastTalkedDayLabel(NOW, new Date(2026, 9, 8, 9, 0).getTime())).toBe(
      "2026-10-08",
    );
  });

  it("never shows a negative day when the clock jumped backwards", () => {
    expect(lastTalkedDayLabel(NOW, NOW + 5 * 86_400_000)).toBe("今天");
  });

  it("no time at all is a dash", () => {
    expect(lastTalkedDayLabel(NOW, null)).toBe("—");
    expect(lastTalkedDayLabel(NOW, 0)).toBe("—");
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
