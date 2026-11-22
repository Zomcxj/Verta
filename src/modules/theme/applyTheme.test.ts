import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBuiltinTheme } from "./themes";
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
    // The surface toggle is a single attribute: `on` means the layer is painted.
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

/** WCAG contrast of two hex colours, so the assertions read as the reader's own question. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const raw = hex.trim().replace("#", "");
    const full = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw.slice(0, 6);
    const parts = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255);
    const linear = parts.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (hi + 0.05) / (lo + 0.05);
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

  it("makes a light theme's white slots readable before the terminal sees them", async () => {
    // Reported as "切到亮色主题后，终端里的白色文字还是白色". The palette is written for a dark background
    // and only the bright white is usually replaced, so the plain white a prompt and `ls` use stays a
    // pale grey: claude light resolved it to #cbc8bd on #faf9f5, which is 1.59:1.
    const { applyTheme } = await loadModule();
    const claude = getBuiltinTheme("claude");
    expect(claude).toBeTruthy();

    applyTheme(claude as Theme, "light");

    const background = written.get("--terminal-background") ?? written.get("--background");
    const white = written.get("--terminal-ansi-white");
    const brightWhite = written.get("--terminal-ansi-bright-white");
    expect(background).toBeTruthy();
    expect(white).toBeTruthy();
    expect(brightWhite).toBeTruthy();
    // The palette's own values are #cbc8bd and #3d3a2f on #faf9f5: 1.59:1 and 8.1:1.
    expect(contrast(white as string, background as string)).toBeGreaterThanOrEqual(3);
    expect(contrast(brightWhite as string, background as string)).toBeGreaterThanOrEqual(4.5);
    // The rest of the palette is the theme's own decision and is not touched.
    expect(written.get("--terminal-ansi-red")).toBe(claude?.variants.light?.terminal?.ansi?.[1]);
    expect(written.get("--terminal-ansi-white")).not.toBe(
      claude?.variants.light?.terminal?.ansi?.[7],
    );
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


  it("does not touch the radius when a shape changes", async () => {
    // The radius is a separate preference: a shape that cleared it would reset the user's corners on
    // every preset change, and one that wrote it would fight the slider.
    const { applyShape } = await loadModule();
    applyShape("cloud");
    expect(removed).not.toContain("--radius");
    expect(written.has("--radius")).toBe(false);
  });

  it("lets the radius axis beat the theme, and leaves the glass terminal alone", async () => {
    // Three axes write the same document in order: theme, then shape, then radius. The radius has to
    // be last (a theme may spell `colors.radius`), and the shape must not take the terminal's
    // transparency back while it works.
    const { applyRadius, applyShape, applyTheme } = await loadModule();
    applyTheme(
      theme({
        dark: variant({
          colors: { background: "#111111", radius: "2rem" },
        }),
      }),
      "dark",
    );
    expect(written.get("--radius")).toBe("2rem");
    applyShape("glass");
    applyRadius("0.25rem");
    expect(written.get("--radius")).toBe("0.25rem");
    expect(written.get("--terminal-background")).toBe("transparent");
    applyShape("minimal");
    expect(written.get("--radius")).toBe("0.25rem");
    expect(written.get("--terminal-background")).not.toBe("transparent");
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

