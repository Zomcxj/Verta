import { afterEach, describe, expect, it, vi } from "vitest";
import { FALLBACK_CHAIN, resolveFontFamily } from "./fonts";

// Read the chain from the module instead of copying it: the CJK tail is part of
// the contract, and a copy here would let the two drift apart silently.
const FALLBACK = FALLBACK_CHAIN;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("terminal font availability", () => {
  it("does not accept an absent font when FontFaceSet.check returns true", async () => {
    const context = {
      font: "",
      measureText: () => ({
        width:
          context.font.endsWith("serif") && !context.font.endsWith("monospace")
            ? 110
            : 100,
      }),
    };
    vi.stubGlobal("document", {
      fonts: { check: () => true },
      createElement: () => ({ getContext: () => context }),
    });
    const { detectMonoFontFamily } = await import("./fonts");
    expect(detectMonoFontFamily()).toBe(FALLBACK);
  });

  it("finds an installed later candidate and caches its measurements", async () => {
    const context = {
      font: "",
      measureText: vi.fn(() => ({
        width: context.font.includes('"Hack Nerd Font"')
          ? 130
          : context.font.endsWith(", serif") || context.font === "16px serif"
            ? 110
            : 100,
      })),
    };
    vi.stubGlobal("document", {
      createElement: () => ({ getContext: () => context }),
    });
    const { detectMonoFontFamily } = await import("./fonts");
    expect(detectMonoFontFamily()).toBe(`"Hack Nerd Font", ${FALLBACK}`);
    const calls = context.measureText.mock.calls.length;
    detectMonoFontFamily();
    expect(context.measureText).toHaveBeenCalledTimes(calls);
  });

  it("loads text fonts before canvas rasterization, only once per window", async () => {
    const load = vi.fn(async () => []);
    vi.stubGlobal("document", { fonts: { load } });
    const { ensureMonoFontsLoaded } = await import("./fonts");
    const first = ensureMonoFontsLoaded();
    expect(ensureMonoFontsLoaded()).toBe(first);
    await first;
    expect(load).toHaveBeenCalledWith('400 14px "JetBrains Mono"');
    expect(load).toHaveBeenCalledWith('700 14px "JetBrains Mono"');
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("resolveFontFamily", () => {
  it("quotes a bare family and appends the mono fallback", () => {
    expect(resolveFontFamily("JetBrainsMono Nerd Font")).toBe(
      `"JetBrainsMono Nerd Font", ${FALLBACK}`,
    );
  });

  it("does not double-quote an already-quoted family", () => {
    expect(resolveFontFamily('"Fira Code"')).toBe(`"Fira Code", ${FALLBACK}`);
  });

  it("passes a comma-separated stack through and still appends fallback", () => {
    expect(resolveFontFamily("Foo, Bar")).toBe(`Foo, Bar, ${FALLBACK}`);
  });

  it("strips stray internal quotes to avoid a malformed token", () => {
    expect(resolveFontFamily('Foo"Bar')).toBe(`"FooBar", ${FALLBACK}`);
  });

  it("trims surrounding whitespace before quoting", () => {
    expect(resolveFontFamily("  Hack Nerd Font  ")).toBe(
      `"Hack Nerd Font", ${FALLBACK}`,
    );
  });

  it("falls back to the mono chain for empty input", () => {
    expect(resolveFontFamily("")).toBe(FALLBACK);
    expect(resolveFontFamily("   ")).toBe(FALLBACK);
  });
});

describe("the CJK tail", () => {
  // The fonts people pick for code carry no Han glyphs. Without a CJK entry the
  // browser's own fallback takes over, and then changing the font moves the
  // Latin text while the Chinese stays where it was: the complaint this chain
  // exists to answer.
  it("names Han faces after the Latin ones, for every stack we build", () => {
    for (const stack of [
      resolveFontFamily("Cascadia Mono"),
      resolveFontFamily(""),
    ]) {
      expect(stack).toContain("Microsoft YaHei");
      expect(stack).toContain("PingFang SC");
      expect(stack).toContain("Noto Sans CJK SC");
      // Still ends in the generic family, so an unusual character has somewhere to go.
      expect(stack.trimEnd().endsWith("monospace")).toBe(true);
    }
  });

  it("puts the Latin pick before the CJK faces, so Latin keeps its font", () => {
    const stack = resolveFontFamily("Cascadia Mono");
    expect(stack.indexOf("Cascadia Mono")).toBeLessThan(
      stack.indexOf("Microsoft YaHei"),
    );
  });
});

describe("resolveFontStack", () => {
  /** Makes detection settle on Hack Nerd Font, using the same stub as the block above. */
  const stubDetection = async () => {
    const context = {
      font: "",
      measureText: vi.fn(() => ({
        width: context.font.includes('"Hack Nerd Font"')
          ? 130
          : context.font.endsWith(", serif") || context.font === "16px serif"
            ? 110
            : 100,
      })),
    };
    vi.stubGlobal("document", {
      createElement: () => ({ getContext: () => context }),
    });
    const mod = await import("./fonts");
    expect(mod.detectMonoFontFamily()).toBe(`"Hack Nerd Font", ${FALLBACK}`);
    return mod;
  };

  it("没选字体时与老行为一致：检测到的 Nerd Font 一把抓", async () => {
    const { resolveFontStack } = await stubDetection();
    expect(resolveFontStack("")).toBe(`"Hack Nerd Font", ${FALLBACK}`);
  });

  it("选了字体：它在前，检测到的 Nerd Font 跟在后面兜图标", async () => {
    const { resolveFontStack } = await stubDetection();
    expect(resolveFontStack("Cascadia Code")).toBe(
      `"Cascadia Code", "Hack Nerd Font", ${FALLBACK}`,
    );
  });

  it("选的正好是检测到的那个字体时不重复", async () => {
    const { resolveFontStack } = await stubDetection();
    expect(resolveFontStack("hack nerd font")).toBe(
      `"hack nerd font", ${FALLBACK}`,
    );
  });

  it("拿别人给的一整串栈时原样放在最前", async () => {
    const { resolveFontStack } = await stubDetection();
    expect(resolveFontStack("Foo, Bar")).toBe(
      `Foo, Bar, "Hack Nerd Font", ${FALLBACK}`,
    );
  });

  it("本机没有任何候选 Nerd Font 时只有选中项 + 兜底链", async () => {
    // An absent font measures the same as both fallbacks, so detection should come up empty.
    const context = {
      font: "",
      measureText: vi.fn(() => ({
        width:
          context.font.endsWith("serif") && !context.font.endsWith("monospace")
            ? 110
            : 100,
      })),
    };
    vi.stubGlobal("document", {
      createElement: () => ({ getContext: () => context }),
    });
    const { resolveFontStack } = await import("./fonts");
    expect(resolveFontStack("Consolas")).toBe(`"Consolas", ${FALLBACK}`);
    expect(resolveFontStack("")).toBe(FALLBACK);
  });
});
