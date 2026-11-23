import type { TerminalPalette, Theme, ThemeColors } from "../types";

/**
 * Terax: the neutral grey the project inherited from upstream, back as an ordinary theme.
 *
 * It was the default until the brand theme took that place (`c3e45c0`), and it is not the brand
 * palette: where Verta presses the base down to near-black (`#0b0b0d`) and the accent up to pure
 * white, this one is a comfortable greyscale with a full-colour terminal.
 *
 * **Every colour here is the one it always had.** Until now they lived in `styles/globals.css`
 * (`:root` / `.dark`) and were reached by `clearTheme()`, because the theme was the default and
 * `ThemeProvider` skipped `applyTheme` for it. Those declarations are still in the stylesheet - they
 * are the pre-paint palette every window starts on - so this file copies them rather than inventing
 * a look. A colour that moves must move in both places or the first paint and the settled window
 * will disagree; `terax.test.ts` holds the two together.
 *
 * The `id` is `terax`, not `verta-default`: that id belongs to the brand theme and to every stored
 * preference that names it. Nothing can be migrated onto it.
 */
const COLORS: ThemeColors = {
  background: "#ffffff",
  foreground: "#111111",
  card: "#f3f3f3",
  cardForeground: "#111111",
  popover: "#ffffff",
  popoverForeground: "#111111",
  primary: "#111111",
  primaryForeground: "#ffffff",
  secondary: "#ededed",
  secondaryForeground: "#111111",
  muted: "#ededed",
  mutedForeground: "#656565",
  accent: "#e5e5e5",
  accentForeground: "#111111",
  destructive: "#c0392f",
  border: "rgba(0, 0, 0, 0.09)",
  input: "rgba(0, 0, 0, 0.13)",
  ring: "#8a8a8a",
  sidebar: "#f3f3f3",
  sidebarForeground: "#111111",
  sidebarPrimary: "#111111",
  sidebarPrimaryForeground: "#ffffff",
  sidebarAccent: "#e5e5e5",
  sidebarAccentForeground: "#111111",
  sidebarBorder: "rgba(0, 0, 0, 0.09)",
  sidebarRing: "#8a8a8a",
  radius: "0.625rem",
};

/** The light appearance's terminal, which is the light palette's own greys and one hue each. */
const TERMINAL_LIGHT: TerminalPalette = {
  background: "#ffffff",
  foreground: "#111111",
  cursor: "#111111",
  cursorAccent: "#ffffff",
  selection: "#e5e5e5",
  ansi: [
    "#111111",
    "#c0392f",
    "#2f7d4f",
    "#a37413",
    "#2f6bb5",
    "#8a4fb5",
    "#227d85",
    "#d8d8d8",
    "#656565",
    "#d94f42",
    "#3d9c64",
    "#bf8a1f",
    "#3f82d4",
    "#a065cf",
    "#2b98a2",
    "#111111",
  ],
};

/** The dark appearance, a shade off black rather than the brand theme's near-black. */
const COLORS_DARK: ThemeColors = {
  background: "#141414",
  foreground: "#f7f7f7",
  card: "#1d1d1d",
  cardForeground: "#f7f7f7",
  popover: "#1d1d1d",
  popoverForeground: "#f7f7f7",
  primary: "#f7f7f7",
  primaryForeground: "#141414",
  secondary: "#2a2a2a",
  secondaryForeground: "#f7f7f7",
  muted: "#1d1d1d",
  mutedForeground: "#a3a3a3",
  accent: "#2a2a2a",
  accentForeground: "#f7f7f7",
  destructive: "#e35d5d",
  border: "rgba(255, 255, 255, 0.09)",
  input: "rgba(255, 255, 255, 0.13)",
  ring: "#8a8a8a",
  sidebar: "#1d1d1d",
  sidebarForeground: "#f7f7f7",
  sidebarPrimary: "#f7f7f7",
  sidebarPrimaryForeground: "#141414",
  sidebarAccent: "#2a2a2a",
  sidebarAccentForeground: "#f7f7f7",
  sidebarBorder: "rgba(255, 255, 255, 0.09)",
  sidebarRing: "#8a8a8a",
  radius: "0.625rem",
};

const TERMINAL_DARK: TerminalPalette = {
  background: "#141414",
  foreground: "#f7f7f7",
  cursor: "#f7f7f7",
  cursorAccent: "#141414",
  selection: "#2a2a2a",
  ansi: [
    "#3f3f3f",
    "#e35d5d",
    "#6ec48f",
    "#e0b34d",
    "#6ea8e8",
    "#b98ce0",
    "#5fc6cc",
    "#d8d8d8",
    "#6e6e6e",
    "#f27f7f",
    "#85d9a4",
    "#eec469",
    "#8dbcf2",
    "#cba5ee",
    "#7bdbe0",
    "#f7f7f7",
  ],
};

export const terax: Theme = {
  id: "terax",
  name: "Terax",
  description: "Clean neutral greys.",
  // Neutral grey both ways, so the editor follows the mode rather than being pinned dark.
  editorTheme: { dark: "github-dark", light: "github-light" },
  variants: {
    light: { colors: COLORS, terminal: TERMINAL_LIGHT },
    dark: { colors: COLORS_DARK, terminal: TERMINAL_DARK },
  },
};
