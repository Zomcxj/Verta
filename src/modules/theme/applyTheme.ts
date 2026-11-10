import { resolveShape, type ShapeOptions } from "./shape";
import type {
  Theme,
  ThemeColors,
  ThemeMode,
  ThemeGlass,
  ThemeSurface,
  TerminalPalette,
} from "./types";

const COLOR_VAR: Record<keyof ThemeColors, string> = {
  background: "--background",
  foreground: "--foreground",
  card: "--card",
  cardForeground: "--card-foreground",
  popover: "--popover",
  popoverForeground: "--popover-foreground",
  primary: "--primary",
  primaryForeground: "--primary-foreground",
  secondary: "--secondary",
  secondaryForeground: "--secondary-foreground",
  muted: "--muted",
  mutedForeground: "--muted-foreground",
  accent: "--accent",
  accentForeground: "--accent-foreground",
  destructive: "--destructive",
  border: "--border",
  input: "--input",
  ring: "--ring",
  sidebar: "--sidebar",
  sidebarForeground: "--sidebar-foreground",
  sidebarPrimary: "--sidebar-primary",
  sidebarPrimaryForeground: "--sidebar-primary-foreground",
  sidebarAccent: "--sidebar-accent",
  sidebarAccentForeground: "--sidebar-accent-foreground",
  sidebarBorder: "--sidebar-border",
  sidebarRing: "--sidebar-ring",
  radius: "--radius",
};

const ANSI_VARS: readonly string[] = [
  "--terminal-ansi-black",
  "--terminal-ansi-red",
  "--terminal-ansi-green",
  "--terminal-ansi-yellow",
  "--terminal-ansi-blue",
  "--terminal-ansi-magenta",
  "--terminal-ansi-cyan",
  "--terminal-ansi-white",
  "--terminal-ansi-bright-black",
  "--terminal-ansi-bright-red",
  "--terminal-ansi-bright-green",
  "--terminal-ansi-bright-yellow",
  "--terminal-ansi-bright-blue",
  "--terminal-ansi-bright-magenta",
  "--terminal-ansi-bright-cyan",
  "--terminal-ansi-bright-white",
];

const ALL_VARS: readonly string[] = [
  ...Object.values(COLOR_VAR),
  "--terminal-background",
  "--terminal-foreground",
  "--terminal-cursor",
  "--terminal-cursor-accent",
  "--terminal-selection",
  ...ANSI_VARS,
];

let lastApplied: string | null = null;

/** Surface-layer variables the theme brings along (all removed when leaving a
 * textured theme). */
const SURFACE_VARS: readonly string[] = [
  "--theme-surface-background",
  "--theme-surface-image",
  "--theme-surface-repeat",
  "--theme-surface-size",
  "--theme-surface-opacity",
  "--theme-surface-blend",
];

/** Glass variables: frame and pane opacity, edge brightness. */
const GLASS_VARS: readonly string[] = [
  "--theme-frame-opacity",
  "--theme-pane-opacity",
  "--theme-glass-edge",
  "--theme-glass-sheen",
];

/**
 * The variables a shape owns, so that leaving one shape removes what it brought.
 *
 * `--radius` is in this list but is also a theme's: the caller says whether the theme is speaking
 * (`ShapeOptions.themeRadius`), and when it is, this one is left alone entirely - it is not the
 * shape's to clear.
 */
const SHAPE_VARS: readonly string[] = [
  "--radius",
  "--pane-border-width",
  "--pane-shadow",
  "--card-shadow",
  "--bevel-top",
  "--bevel-bottom",
  "--accent-bar",
];

/**
 * Writes a shape onto the document element.
 *
 * The thin cell around `resolveShape`, which decides everything and touches nothing: this puts the
 * answer where the stylesheet can read it. What a shape brought along is cleared first, so switching
 * from `emboss` to `soft` does not leave a lit edge behind; a shape is not "the variables it adds"
 * but "the whole set", and `soft` answers the values the stylesheet already had.
 */
export function applyShape(
  shapeId: unknown,
  options: ShapeOptions = {},
): void {
  const root = document.documentElement;
  const { vars, attrs } = resolveShape(shapeId, options);
  for (const name of SHAPE_VARS) {
    if (name === "--radius" && options.themeRadius) continue;
    root.style.removeProperty(name);
  }
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
  // The material is an attribute, not a variable: the blur happens behind the window.
  root.removeAttribute("data-shape-material");
  for (const [name, value] of Object.entries(attrs)) root.setAttribute(name, value);
}

export function applyTheme(theme: Theme, mode: ThemeMode): void {
  const root = document.documentElement;
  const variant = theme.variants[mode] ?? theme.variants.dark ?? theme.variants.light;
  if (!variant) {
    clearTheme();
    return;
  }
  const colors = variant.colors;
  const terminal = variant.terminal;
  for (const v of ALL_VARS) root.style.removeProperty(v);
  if (colors) writeColors(root, colors);
  if (terminal) writeTerminal(root, terminal);
  writeSurface(root, variant.surface);
  writeGlass(root, variant.glass);
  lastApplied = theme.id;
}

export function clearTheme(): void {
  if (lastApplied === null) return;
  const root = document.documentElement;
  for (const v of ALL_VARS) root.style.removeProperty(v);
  writeSurface(root, undefined);
  writeGlass(root, undefined);
  lastApplied = null;
}

/**
 * The surface layer only writes CSS variables; `SurfaceLayer` on
 * `[data-theme-surface]` does the actual painting.
 *
 * It does not paint onto `body`: with a background image enabled that layer covers
 * the whole screen, so coloring body too would fight it, and the settings and
 * screenshot windows would change along. Variables live on a dedicated element and
 * whoever needs them reads them.
 */
function writeSurface(root: HTMLElement, surface: ThemeSurface | undefined): void {
  for (const v of SURFACE_VARS) root.style.removeProperty(v);
  if (!surface) {
    root.removeAttribute("data-theme-surface");
    return;
  }
  const set = (name: string, value: string | number | undefined) => {
    if (value === undefined || value === "") return;
    root.style.setProperty(name, String(value));
  };
  set("--theme-surface-background", surface.background);
  set("--theme-surface-image", surface.image);
  set("--theme-surface-repeat", surface.repeat);
  set("--theme-surface-size", surface.size);
  set("--theme-surface-opacity", surface.opacity);
  set("--theme-surface-blend", surface.blend);
  const drawn = surface.background || surface.image;
  if (drawn) root.setAttribute("data-theme-surface", "on");
  else root.removeAttribute("data-theme-surface");
}

/**
 * Glass: enabled only when an opacity is actually supplied
 * (`data-theme-glass="on"`).
 *
 * CSS uses that attribute to decide whether `--frame` and `.verta-pane` switch to
 * translucent values; without it the two layers keep their opaque styling and cost
 * nothing extra.
 */
function writeGlass(root: HTMLElement, glass: ThemeGlass | undefined): void {
  for (const v of GLASS_VARS) root.style.removeProperty(v);
  if (!glass) {
    root.removeAttribute("data-theme-glass");
    return;
  }
  const set = (name: string, value: number | undefined) => {
    if (value === undefined) return;
    // The floor is 0.02: Apple-style glass panes are nearly fully transparent, with
    // text carried by the blur and highlights.
    root.style.setProperty(name, String(Math.min(1, Math.max(0.02, value))));
  };
  set("--theme-frame-opacity", glass.frame);
  set("--theme-pane-opacity", glass.pane);
  // Deliberately no `filter` here: the blur is a native material (DWM acrylic on
  // Windows, NSVisualEffectView on macOS) painted **behind** the window, out of
  // CSS's reach, and a blur on #root only smears the UI itself; the first version
  // did exactly that and looked like a smear rather than glass. Saturation is the
  // same story: the material brings its own, and stacking more would recolor the UI.
  if (glass.sheen !== undefined) {
    root.style.setProperty(
      "--theme-glass-sheen",
      String(Math.min(1, Math.max(0, glass.sheen))),
    );
  }
  if (glass.edge !== undefined) {
    root.style.setProperty(
      "--theme-glass-edge",
      String(Math.min(1, Math.max(0, glass.edge))),
    );
  }
  root.setAttribute("data-theme-glass", "on");
}

function writeColors(root: HTMLElement, c: ThemeColors): void {
  for (const k of Object.keys(c) as (keyof ThemeColors)[]) {
    const v = c[k];
    if (v) root.style.setProperty(COLOR_VAR[k], v);
  }
}

function writeTerminal(root: HTMLElement, t: TerminalPalette): void {
  if (t.background) root.style.setProperty("--terminal-background", t.background);
  if (t.foreground) root.style.setProperty("--terminal-foreground", t.foreground);
  if (t.cursor) root.style.setProperty("--terminal-cursor", t.cursor);
  if (t.cursorAccent) root.style.setProperty("--terminal-cursor-accent", t.cursorAccent);
  if (t.selection) root.style.setProperty("--terminal-selection", t.selection);
  if (t.ansi) {
    for (let i = 0; i < ANSI_VARS.length && i < t.ansi.length; i++) {
      root.style.setProperty(ANSI_VARS[i], t.ansi[i]);
    }
  }
}
