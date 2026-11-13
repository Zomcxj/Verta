import { describe, expect, it } from "vitest";

import { BUNDLED_FONT_FAMILIES, fontOptions } from "./fontOptions";

const AUTO = "自动检测";
/** These cases are about the machine's own list; the bundled entry is covered on its own below. */
const NO_BUNDLED: readonly string[] = [];

describe("fontOptions", () => {
  it("第一项永远是「自动检测」（空串）", () => {
    const options = fontOptions(["Cascadia Code"], "", AUTO, NO_BUNDLED);
    expect(options[0]).toEqual({ value: "", label: AUTO });
    expect(options.map((option) => option.value)).toEqual([
      "",
      "Cascadia Code",
    ]);
  });

  it("读不到字体列表时只给自动检测 + 当前值", () => {
    const options = fontOptions(null, "Cascadia Code", AUTO, NO_BUNDLED);
    expect(options).toEqual([
      { value: "", label: AUTO },
      { value: "Cascadia Code", label: "Cascadia Code", missing: true },
    ]);
  });

  it("当前值在本机装着时不重复、也不标 missing", () => {
    const options = fontOptions(
      ["Cascadia Code", "Iosevka"],
      "Cascadia Code",
      AUTO,
      NO_BUNDLED,
    );
    expect(options).toEqual([
      { value: "", label: AUTO },
      { value: "Cascadia Code", label: "Cascadia Code" },
      { value: "Iosevka", label: "Iosevka" },
    ]);
  });

  it("当前值本机没有时插在自动检测后面并标出来（配置可能来自别的机器）", () => {
    const options = fontOptions(["Iosevka"], "  Fira Code  ", AUTO, NO_BUNDLED);
    expect(options[1]).toEqual({
      value: "Fira Code",
      label: "Fira Code",
      missing: true,
    });
    expect(options[2]).toEqual({ value: "Iosevka", label: "Iosevka" });
  });

  it("比大小写：本机有 Cascadia Code 时，配的小写不算 missing", () => {
    const options = fontOptions(["Cascadia Code"], "cascadia code", AUTO, NO_BUNDLED);
    expect(options.filter((option) => option.value)).toEqual([
      { value: "Cascadia Code", label: "Cascadia Code" },
    ]);
  });

  it("列表里的空串与重复项不进下拉", () => {
    const options = fontOptions(["", "Iosevka", "iosevka", "  "], "", AUTO, NO_BUNDLED);
    expect(options.map((option) => option.value)).toEqual(["", "Iosevka"]);
  });
});

describe("the families the application ships", () => {
  it("are offered even when the machine does not have them", () => {
    // JetBrains Mono is not installed on the machine that reported this, and yet it is what every
    // stack ends in - so it has to be visible and choosable.
    const options = fontOptions(["Cascadia Code"], "Cascadia Code", AUTO);
    expect(BUNDLED_FONT_FAMILIES).toEqual(["JetBrains Mono"]);
    expect(options[1]).toEqual({
      value: "JetBrains Mono",
      label: "JetBrains Mono",
      bundled: true,
    });
    // Not "missing": the face ships with the app, so saying it is not installed would be the wrong
    // warning about a font that always works.
    expect(options[1].missing).toBeUndefined();
  });

  it("come before the machine's own list, because they work everywhere", () => {
    const options = fontOptions(["Cascadia Code", "Iosevka"], "", AUTO);
    expect(options.map((option) => option.value)).toEqual([
      "",
      "JetBrains Mono",
      "Cascadia Code",
      "Iosevka",
    ]);
  });

  it("are not listed twice when the machine happens to have them too", () => {
    const options = fontOptions(["JetBrains Mono", "Iosevka"], "", AUTO);
    expect(options.filter((option) => option.value === "JetBrains Mono")).toEqual([
      { value: "JetBrains Mono", label: "JetBrains Mono", bundled: true },
    ]);
  });

  it("do not make a shipped current value look uninstalled", () => {
    const options = fontOptions(["Iosevka"], "JetBrains Mono", AUTO);
    expect(options.filter((option) => option.value === "JetBrains Mono")).toEqual([
      { value: "JetBrains Mono", label: "JetBrains Mono", bundled: true },
    ]);
  });
});

