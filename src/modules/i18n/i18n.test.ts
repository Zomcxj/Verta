import { describe, expect, it } from "vitest";
import { resolveLanguage } from "./language";
import { MESSAGES, translate } from "./messages";

describe("resolveLanguage", () => {
  it("follows the system locale when nothing is chosen", () => {
    expect(resolveLanguage("system", "zh-CN")).toBe("zh");
    expect(resolveLanguage("system", "en-US")).toBe("en");
  });

  it("treats every Chinese locale as Chinese, not just zh-CN", () => {
    // A traditional-script or regional tag is still Chinese.
    expect(resolveLanguage("system", "zh-Hant-TW")).toBe("zh");
    expect(resolveLanguage("system", "zh-HK")).toBe("zh");
  });

  it("falls back to English for a missing or unknown locale", () => {
    expect(resolveLanguage("system", undefined)).toBe("en");
    expect(resolveLanguage("system", "de-DE")).toBe("en");
  });

  it("lets an explicit choice win over the system locale", () => {
    expect(resolveLanguage("en", "zh-CN")).toBe("en");
    expect(resolveLanguage("zh", "en-US")).toBe("zh");
  });
});

describe("translate", () => {
  it("returns the string for the requested language", () => {
    expect(translate("zh", "rail.sessions")).toBe("会话");
    expect(translate("en", "rail.sessions")).toBe("Sessions");
  });

  it("substitutes named values", () => {
    expect(translate("en", "launcher.selectedCount", { count: 3 })).toBe(
      "3 selected",
    );
    expect(translate("zh", "launcher.selectedCount", { count: 3 })).toBe(
      "已选 3 条",
    );
  });

  it("leaves an unknown placeholder alone instead of printing undefined", () => {
    expect(
      translate("en", "launcher.selectedCount", { other: "x" }),
    ).toBe("{count} selected");
  });
});

describe("message tables", () => {
  it("defines every key in both languages", () => {
    // A key present in one table and missing from the other is a blank label in
    // whichever language the user picks, so the tables must match exactly.
    expect(Object.keys(MESSAGES.en).sort()).toEqual(
      Object.keys(MESSAGES.zh).sort(),
    );
  });

  it("has no empty strings", () => {
    for (const [language, table] of Object.entries(MESSAGES)) {
      for (const [key, value] of Object.entries(table)) {
        expect(value.trim(), `${language}:${key}`).not.toBe("");
      }
    }
  });
});
