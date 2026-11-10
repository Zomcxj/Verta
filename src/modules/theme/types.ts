import type { ShapeId } from "./shape";

export type ThemeMode = "light" | "dark";

export type ThemeColors = Partial<{
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  border: string;
  input: string;
  ring: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarPrimary: string;
  sidebarPrimaryForeground: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  sidebarBorder: string;
  sidebarRing: string;
  radius: string;
}>;

export type TerminalPalette = Partial<{
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selection: string;
  fontFamily: string;
  fontWeight: string;
  fontSize: number;
  ansi: readonly [
    string, string, string, string, string, string, string, string,
    string, string, string, string, string, string, string, string,
  ];
}>;

/**
 * The "texture" layer of the UI: a CSS background painted under all content.
 *
 * Pure CSS only (gradients, very faint SVG noise), and **deliberately no frosted
 * glass**: blur would force an extra compositing layer for the whole window,
 * which is expensive while dragging and resizing, and it fights the compositing
 * budget the background image already uses.
 */
export type ThemeSurface = {
  /** Background color for the whole layer; omitted means transparent (the theme's
   * own background shows through). */
  background?: string;
  /** The `background-image` painted on top (gradient / data-URI SVG). */
  image?: string;
  /** How the image repeats. Gradients usually `no-repeat`; textures need `repeat`. */
  repeat?: "no-repeat" | "repeat";
  /** Image size (`background-size`). */
  size?: string;
  /** Opacity, 0-1. */
  opacity?: number;
  /**
   * Blends with the theme's base color: a `mix-blend-mode` such as `soft-light`
   * or `overlay`, so the texture follows the light and dark palettes instead of
   * hard-coding a color.
   */
  blend?: string;
};

/**
 * Glass: makes the window frame and panes **genuinely translucent** so the
 * surface layer shows through.
 *
 * By default both the `frame` and `pane` layers are opaque (the backgrounds of
 * `--frame` and `.verta-pane`), so a texture on `surface` alone is invisible;
 * they cover all of it. Glass means letting those two layers show through,
 * brightening the border a little (the glass edge), and adding some backdrop
 * blur to panes.
 *
 * Blur is **not controlled here**: the real blur is a native material painted
 * behind the window (DWM acrylic on Windows, NSVisualEffectView on macOS), which
 * CSS cannot reach. Only tint and highlights are adjustable: see below.
 */
export type ThemeGlass = {
  /** Pane **opacity**, 0-1; lower is more transparent. 0.15 is essentially pure glass. */
  pane?: number;
  /** Opacity of the frame layer (title bar, status bar, the gaps between panes), 0-1. */
  frame?: number;
  /** Glass edge brightness: strength of the top highlight and border, 0-1. */
  edge?: number;
  /** Opacity of the highlight gradient at the top of a pane, 0-1. It carries the
   * light-on-top, dark-below look of Apple glass. */
  sheen?: number;
  /**
   * Whether the **desktop** shows through too (acrylic on Windows, vibrancy on
   * macOS).
   *
   * Layering a gradient inside the window only ever blends the window with
   * itself; real liquid glass sits on top of the desktop. Enabling this makes the
   * theme switch the native window background to acrylic on its own, so the user
   * does not have to flip a setting as well.
   */
  desktop?: boolean;
};

export type ThemeVariant = {
  colors?: ThemeColors;
  terminal?: TerminalPalette;
  surface?: ThemeSurface;
  glass?: ThemeGlass;
  /**
   * What this variant wants of the things that used to be global switches: the desktop material,
   * and how the user's own background image is drawn. A user value always wins; see
   * `resolveAppearance`.
   */
  appearance?: ThemeAppearance;
};

/**
 * The "appearance" layer: the parts of the window that are not colours.
 *
 * All three were global preferences before a theme could have an opinion about them, and a theme is
 * the thing that knows what it is for - a glass theme wants the material, a paper theme does not.
 * Nothing here names a background *image*: an image is an asset on this machine, while a theme file
 * is JSON that can be exported and shared, so a theme says how the background is drawn, not what it
 * is.
 */
export type ThemeAppearance = {
  /** Desktop material. Absent means none, which is what a missing switch means today. */
  backdrop?: "native" | "acrylic";
  /** Default opacity of the user's background image, 0-1 (today's `backgroundOpacity`, 0.5). */
  backgroundOpacity?: number;
  /** Default blur of the user's background image, 0-64 (today's `backgroundBlur`, 0). */
  backgroundBlur?: number;
};

export type Theme = {
  id: string;
  name: string;
  author?: string;
  description?: string;
  variants: {
    light?: ThemeVariant;
    dark?: ThemeVariant;
  };
  /**
   * The shape this theme suggests (corners, borders, shadows).
   *
   * A suggestion, not a command: a shape the user chose wins, the same way `editorTheme` and
   * `EDITOR_THEME_AUTO` work. Absent means the default shape.
   */
  shape?: ShapeId;
  editorTheme?: {
    light?: string;
    dark?: string;
  };
};

export const DEFAULT_THEME_ID = "verta-default";
