import { describe, expect, it } from "vitest";
import { relativeTime } from "./relativeTime";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = 1_792_000_000_000;

describe("relativeTime", () => {
  it("shows just now under a minute", () => {
    expect(relativeTime(NOW, NOW - 30_000, "zh")).toBe("刚刚");
  });

  it("shows minutes", () => {
    expect(relativeTime(NOW, NOW - 5 * MINUTE, "zh")).toBe("5 分钟前");
  });

  it("shows hours", () => {
    expect(relativeTime(NOW, NOW - 3 * HOUR, "zh")).toBe("3 小时前");
  });

  it("shows days", () => {
    expect(relativeTime(NOW, NOW - 2 * DAY - HOUR, "zh")).toBe("2 天前");
  });

  it("switches to an absolute date after 30 days", () => {
    expect(relativeTime(NOW, NOW - 40 * DAY, "zh")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("never shows a negative age when the clock moved backwards", () => {
    expect(relativeTime(NOW, NOW + 5 * MINUTE, "zh")).toBe("刚刚");
  });

  it("handles a missing timestamp", () => {
    expect(relativeTime(NOW, 0, "zh")).toBe("时间未知");
  });

  // Guards the language argument actually reaching the message table: the same
  // age must not come back in Chinese once the UI is English.
  it("uses the English wording when asked for English", () => {
    expect(relativeTime(NOW, NOW - 5 * MINUTE, "en")).toBe("5 min ago");
    expect(relativeTime(NOW, NOW - 3 * HOUR, "en")).toBe("3 h ago");
    expect(relativeTime(NOW, NOW - 2 * DAY, "en")).toBe("2 d ago");
  });
});
