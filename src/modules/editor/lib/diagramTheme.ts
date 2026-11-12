import type { ThemeMode } from "@/modules/theme/types";
import { parseCssColor, toHex } from "@/modules/theme/vibrancy";
import { readCssColorVar } from "@/styles/tokens";

/**
 * The theme colours a diagram is drawn from, as opaque sRGB hex.
 *
 * Hex rather than `var(--card)`, because mermaid does arithmetic on every one of these before it
 * draws anything: its base theme derives borders with `adjust`, brushed-off text with `invert` and
 * the quieter fills with `darken`/`lighten`, and none of those can be done on a `var()` reference or
 * on an `oklch()` colour - the arithmetic silently produces nothing and the diagram is what breaks.
 * Reading the tokens here, once per theme, keeps the arithmetic on numbers.
 *
 * Translucent tokens are dropped for the same reason: they are resolved, not composited, so
 * `--border`'s `rgba(..., 0.09)` would reach mermaid as an alpha that every derivation then carries
 * around. Borders are left to mermaid to derive from `panel`, which is also how they come out
 * readable in both modes without a second colour axis here.
 */
export type DiagramPalette = {
  /** What the drawing sits on: the app's own background, not a colour of the diagram's own. */
  surface: string;
  /** Ordinary text. */
  text: string;
  /** A node's fill. */
  panel: string;
  /** A node's text. Mermaid draws it *on* `panel`, so the pair is the one that has to be readable. */
  panelText: string;
  /** The quieter furniture: clusters, notes, sequence boxes. */
  muted: string;
  /** Edges and arrowheads, i.e. the colour the app uses for secondary text. */
  mutedText: string;
};

const TOKENS: Record<keyof DiagramPalette, string> = {
  surface: "--background",
  text: "--foreground",
  panel: "--card",
  panelText: "--card-foreground",
  muted: "--muted",
  mutedText: "--muted-foreground",
};

/**
 * The tokens the shell paints before a theme is applied (`globals.css`), used when a variable is
 * missing or cannot be read as an opaque colour.
 */
const BASELINE: Record<ThemeMode, DiagramPalette> = {
  light: {
    surface: "#ffffff",
    text: "#111111",
    panel: "#f3f3f3",
    panelText: "#111111",
    muted: "#ededed",
    mutedText: "#656565",
  },
  dark: {
    surface: "#141414",
    text: "#f7f7f7",
    panel: "#1d1d1d",
    panelText: "#f7f7f7",
    muted: "#1d1d1d",
    mutedText: "#a3a3a3",
  },
};

/**
 * The palette the current theme paints with.
 *
 * A token that is absent, translucent or in a colour space the arithmetic above cannot read keeps
 * the baseline value: a slightly wrong shade is worth more than a diagram that does not draw.
 *
 * Where the diagram draws inside a glass pane (the pane tints rather than paints), `surface` is the
 * theme's background and the diagram is drawn on a slab of it - see `MermaidDiagram`, which is the
 * one place that decides this.
 */
export function readDiagramPalette(mode: ThemeMode): DiagramPalette {
  const palette = { ...BASELINE[mode] };
  for (const key of Object.keys(TOKENS) as (keyof DiagramPalette)[]) {
    const value = parseCssColor(readCssColorVar(TOKENS[key]));
    if (value) palette[key] = toHex(value);
  }
  return palette;
}

/** What the diagram inherits from the pane it is drawn in rather than from the theme. */
export type DiagramLook = {
  dark: boolean;
  /** The pane's own font, so a label reads like the text around it. */
  fontFamily: string;
  /** Likewise its size, which follows the editor font-size setting. */
  fontSize: string;
};

/**
 * Mermaid's `themeVariables` for one palette.
 *
 * Only the colours a diagram actually paints are named. Everything else - borders, hover states,
 * the colour scale the charts use - is left to mermaid's base theme, which derives it from these and
 * from `darkMode`; naming them here would be pinning values this app has no opinion about.
 */
export function mermaidThemeVariables(
  palette: DiagramPalette,
  look: DiagramLook,
): Record<string, string | boolean> {
  return {
    darkMode: look.dark,
    fontFamily: look.fontFamily,
    fontSize: look.fontSize,
    // The panes are flat and the palette is neutral, so mermaid's default two-tone node gradient
    // would be an artefact of its defaults rather than a decision of the theme.
    useGradient: false,
    background: palette.surface,
    primaryColor: palette.panel,
    mainBkg: palette.panel,
    primaryTextColor: palette.panelText,
    nodeTextColor: palette.panelText,
    secondaryColor: palette.muted,
    tertiaryColor: palette.muted,
    clusterBkg: palette.muted,
    lineColor: palette.mutedText,
    defaultLinkColor: palette.mutedText,
    textColor: palette.text,
    titleColor: palette.text,
    edgeLabelBackground: palette.surface,
  };
}
