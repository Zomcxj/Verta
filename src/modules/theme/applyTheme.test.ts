import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Theme, ThemeVariant } from "./types";

const removed: string[] = [];
const written = new Map<string, string>();

function stubDocument() {
  const attributes = new Map<string, string>();
  const root = {
    style: {
      removeProperty: vi.fn((v: string) => {
        removed.push(v);
        written.delete(v);
      }),
      setProperty: vi.fn((k: string, v: string) => {
        written.set(k, v);
      }),
    },
    // 表面层开关就是一个属性：`on` 表示这层要画。
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
    getAttribute: (name: string) => attributes.get(name) ?? null,
  };
  vi.stubGlobal("document", { documentElement: root });
  return attributes;
}

function variant(partial: Partial<ThemeVariant>): ThemeVariant {
  return partial;
}

function theme(variants: Theme["variants"], id = "test-theme"): Theme {
  return { id, name: "Test", author: "", description: "", variants };
}

async function loadModule() {
  return await import("./applyTheme");
}

describe("theme application", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    removed.length = 0;
    written.clear();
    stubDocument();
  });

  it("writes color and terminal variables for the requested mode", async () => {
    const { applyTheme } = await loadModule();

    applyTheme(
      theme({
        dark: variant({
          colors: { background: "#111111", cardForeground: "#eeeeee", radius: "8px" },
          terminal: {
            background: "#000000",
            cursor: "#ffffff",
            ansi: [
              "#010101", "#020202", "#030303", "#040404",
              "#050505", "#060606", "#070707", "#080808",
              "#090909", "#0a0a0a", "#0b0b0b", "#0c0c0c",
              "#0d0d0d", "#0e0e0e", "#0f0f0f", "#101010",
            ],
          },
        }),
      }),
      "dark",
    );

    expect(written.get("--background")).toBe("#111111");
    expect(written.get("--card-foreground")).toBe("#eeeeee");
    expect(written.get("--radius")).toBe("8px");
    expect(written.get("--terminal-background")).toBe("#000000");
    expect(written.get("--terminal-cursor")).toBe("#ffffff");
    expect(written.get("--terminal-ansi-black")).toBe("#010101");
    expect(written.get("--terminal-ansi-red")).toBe("#020202");
    expect(written.get("--terminal-ansi-bright-white")).toBe("#101010");
  });

  it("falls back to dark then light when the mode is missing", async () => {
    const { applyTheme } = await loadModule();
    const onlyLight = theme({
      light: variant({ colors: { background: "#fafafa" } }),
    });

    applyTheme(onlyLight, "dark");

    expect(written.get("--background")).toBe("#fafafa");
  });

  it("clears every variable before writing so stale keys never linger", async () => {
    const { applyTheme } = await loadModule();

    applyTheme(
      theme({ dark: variant({ colors: { primary: "#123456" }, terminal: { cursor: "#abcdef" } }) }),
      "dark",
    );
    removed.length = 0;

    applyTheme(theme({ dark: variant({ colors: { accent: "#654321" } }) }), "dark");

    const removedSet = new Set(removed);
    expect(removedSet.has("--primary")).toBe(true);
    expect(removedSet.has("--terminal-cursor")).toBe(true);
    expect(written.has("--primary")).toBe(false);
    expect(written.get("--accent")).toBe("#654321");
  });

  it("clears the surface when a theme has no usable variant", async () => {
    const { applyTheme, clearTheme } = await loadModule();
    applyTheme(
      theme({ dark: variant({ colors: { primary: "#123456" } }) }),
      "dark",
    );
    expect(written.size).toBeGreaterThan(0);

    applyTheme(theme({}), "dark");

    expect(written.size).toBe(0);

    clearTheme();
    clearTheme();
    expect(written.size).toBe(0);
  });

  it("ignores empty-string color values instead of writing them", async () => {
    const { applyTheme } = await loadModule();

    applyTheme(
      theme({ dark: variant({ colors: { background: "", foreground: "#ffffff" } }) }),
      "dark",
    );

    expect(written.has("--background")).toBe(false);
    expect(written.get("--foreground")).toBe("#ffffff");
  });
});

describe("theme surface", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    removed.length = 0;
    written.clear();
  });

  it("writes the surface as variables and turns the layer on", async () => {
    const attributes = stubDocument();
    const { applyTheme } = await loadModule();
    applyTheme(
      theme({
        dark: {
          surface: {
            background: "#101018",
            image: "url(web.svg)",
            repeat: "repeat",
            size: "460px 460px",
            opacity: 0.2,
            blend: "soft-light",
          },
        },
      }),
      "dark",
    );
    expect(written.get("--theme-surface-background")).toBe("#101018");
    expect(written.get("--theme-surface-image")).toBe("url(web.svg)");
    expect(written.get("--theme-surface-repeat")).toBe("repeat");
    expect(written.get("--theme-surface-opacity")).toBe("0.2");
    expect(written.get("--theme-surface-blend")).toBe("soft-light");
    expect(attributes.get("data-theme-surface")).toBe("on");
  });

  it("leaves the layer off for a theme without a surface", async () => {
    const attributes = stubDocument();
    const { applyTheme } = await loadModule();
    applyTheme(theme({ dark: { colors: { background: "#000" } } }), "dark");
    expect(attributes.has("data-theme-surface")).toBe(false);
    expect(written.has("--theme-surface-image")).toBe(false);
  });

  it("drops the surface when switching from one textured theme to another", async () => {
    const attributes = stubDocument();
    const { applyTheme } = await loadModule();
    applyTheme(
      theme({ dark: { surface: { image: "url(web.svg)" } } }, "with-surface"),
      "dark",
    );
    expect(attributes.get("data-theme-surface")).toBe("on");
    applyTheme(theme({ dark: { colors: { background: "#000" } } }, "plain"), "dark");
    expect(attributes.has("data-theme-surface")).toBe(false);
    expect(written.has("--theme-surface-image")).toBe(false);
  });
});

