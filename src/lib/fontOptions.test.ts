import { describe, expect, it } from "vitest";

import { fontOptions } from "./fontOptions";

const AUTO = "自动检测";

describe("fontOptions", () => {
  it("第一项永远是「自动检测」（空串）", () => {
    const options = fontOptions(["Cascadia Code"], "", AUTO);
    expect(options[0]).toEqual({ value: "", label: AUTO });
    expect(options.map((option) => option.value)).toEqual([
      "",
      "Cascadia Code",
    ]);
  });

  it("读不到字体列表时只给自动检测 + 当前值", () => {
    const options = fontOptions(null, "Cascadia Code", AUTO);
    expect(options).toEqual([
      { value: "", label: AUTO },
      { value: "Cascadia Code", label: "Cascadia Code", missing: true },
    ]);
  });

  it("当前值在本机装着时不重复、也不标 missing", () => {
    const options = fontOptions(["Cascadia Code", "Iosevka"], "Cascadia Code", AUTO);
    expect(options).toEqual([
      { value: "", label: AUTO },
      { value: "Cascadia Code", label: "Cascadia Code" },
      { value: "Iosevka", label: "Iosevka" },
    ]);
  });

  it("当前值本机没有时插在自动检测后面并标出来（配置可能来自别的机器）", () => {
    const options = fontOptions(["Iosevka"], "  Fira Code  ", AUTO);
    expect(options[1]).toEqual({
      value: "Fira Code",
      label: "Fira Code",
      missing: true,
    });
    expect(options[2]).toEqual({ value: "Iosevka", label: "Iosevka" });
  });

  it("比大小写：本机有 Cascadia Code 时，配的小写不算 missing", () => {
    const options = fontOptions(["Cascadia Code"], "cascadia code", AUTO);
    expect(options.filter((option) => option.value)).toEqual([
      { value: "Cascadia Code", label: "Cascadia Code" },
    ]);
  });

  it("列表里的空串与重复项不进下拉", () => {
    const options = fontOptions(["", "Iosevka", "iosevka", "  "], "", AUTO);
    expect(options.map((option) => option.value)).toEqual(["", "Iosevka"]);
  });
});
