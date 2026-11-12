import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DiagramPalette,
  mermaidThemeVariables,
  readDiagramPalette,
} from "./diagramTheme";

const DARK: DiagramPalette = {
  surface: "#141414",
  text: "#f7f7f7",
  panel: "#1d1d1d",
  panelText: "#f7f7f7",
  muted: "#1d1d1d",
  mutedText: "#a3a3a3",
};

const LOOK = { dark: true, fontFamily: '"Inter", sans-serif', fontSize: "13px" };

/**
 * Stands in for the document: the tokens module resolves a variable by painting it on a probe and
 * reading `color` back, which is exactly one `createElement`, one `style`, one `getComputedStyle`.
 */
function stubTokenValue(color: string) {
  const element = {
    style: {} as CSSStyleDeclaration,
    setAttribute: () => undefined,
    isConnected: false,
  };
  vi.stubGlobal("document", {
    createElement: () => element,
    body: { appendChild: () => element },
  });
  vi.stubGlobal("getComputedStyle", () => ({ color }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the palette a diagram is drawn from", () => {
  it("reads each token through the theme, so a theme switch moves the diagram with it", () => {
    stubTokenValue("rgb(20, 20, 20)");
    const palette = readDiagramPalette("dark");
    expect(palette.surface).toBe("#141414");
    expect(palette.panel).toBe("#141414");
  });

  it("converts a colour space mermaid's arithmetic cannot read into one it can", () => {
    // A custom theme may spell its colours in `oklch()`, which is what the webview hands back for
    // them; the diagram theme needs numbers, so they are converted rather than passed through.
    stubTokenValue("oklch(0.2 0.01 250)");
    const palette = readDiagramPalette("dark");
    expect(palette.panel).toMatch(/^#[0-9a-f]{6}$/);
    expect(palette.panel).not.toBe(DARK.panel);
  });

  it("falls back to the shell's baseline when a token cannot be read as a solid colour", () => {
    // A translucent token is the real case: `--border` is `rgba(255, 255, 255, 0.09)`, and mermaid
    // carries whatever alpha it is given into every colour it derives. An unresolved variable (`""`,
    // which is what a document without the theme returns) is the other.
    stubTokenValue("rgba(255, 255, 255, 0.09)");
    expect(readDiagramPalette("dark")).toEqual(DARK);
    stubTokenValue("");
    expect(readDiagramPalette("light").surface).toBe("#ffffff");
    expect(readDiagramPalette("dark").surface).toBe("#141414");
  });
});

describe("the theme variables handed to mermaid", () => {
  const variables = mermaidThemeVariables(DARK, LOOK);

  it("names only colours it can do arithmetic on", () => {
    // Mermaid's base theme derives borders with `adjust`, text with `invert` and fills with
    // `darken`; a `var()` reference or an `oklch()` colour is not a value those can work on, and the
    // failure is not an error - it is a diagram that comes out blank or black.
    for (const [key, value] of Object.entries(variables)) {
      if (key === "fontFamily" || key === "fontSize") continue;
      if (typeof value !== "string") continue;
      expect(value, key).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("draws a node's text on the node's own fill", () => {
    expect(variables.primaryColor).toBe(DARK.panel);
    expect(variables.mainBkg).toBe(DARK.panel);
    expect(variables.primaryTextColor).toBe(DARK.panelText);
    expect(variables.nodeTextColor).toBe(DARK.panelText);
  });

  it("draws edges in the colour the app uses for secondary text, not in the fill", () => {
    expect(variables.lineColor).toBe(DARK.mutedText);
    expect(variables.defaultLinkColor).toBe(DARK.mutedText);
  });

  it("takes the pane's own font, so a label reads like the text beside it", () => {
    expect(variables.fontFamily).toBe(LOOK.fontFamily);
    expect(variables.fontSize).toBe(LOOK.fontSize);
  });

  it("tells mermaid which way round the palette is", () => {
    expect(variables.darkMode).toBe(true);
    expect(mermaidThemeVariables(DARK, { ...LOOK, dark: false }).darkMode).toBe(
      false,
    );
  });

  it("leaves borders and the colour scale to mermaid", () => {
    // Naming them here would pin values this app has no opinion about; mermaid derives both from
    // `primaryColor` and `darkMode`, which is the same input the rest of the drawing uses.
    expect(variables.primaryBorderColor).toBeUndefined();
    expect(variables.cScale1).toBeUndefined();
  });
});
