import { describe, expect, it } from "vitest";
import { relativeTime } from "./relativeTime";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = 1_792_000_000_000;

describe("relativeTime", () => {
  it("shows just now under a minute", () => {
    expect(relativeTime(NOW, NOW - 30_000)).toBe("刚刚");
  });

  it("shows minutes", () => {
    expect(relativeTime(NOW, NOW - 5 * MINUTE)).toBe("5 分钟前");
  });

  it("shows hours", () => {
    expect(relativeTime(NOW, NOW - 3 * HOUR)).toBe("3 小时前");
  });

  it("shows days", () => {
    expect(relativeTime(NOW, NOW - 2 * DAY - HOUR)).toBe("2 天前");
  });

  it("switches to an absolute date after 30 days", () => {
    expect(relativeTime(NOW, NOW - 40 * DAY)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("never shows a negative age when the clock moved backwards", () => {
    expect(relativeTime(NOW, NOW + 5 * MINUTE)).toBe("刚刚");
  });

  it("handles a missing timestamp", () => {
    expect(relativeTime(NOW, 0)).toBe("时间未知");
  });
});
