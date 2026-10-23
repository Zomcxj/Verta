import type { TerminalPalette, Theme, ThemeColors } from "../types";

/**
 * Verta — the app icon is a white V on black, so this theme's palette follows it
 * directly: a near-black base, pure white as the accent, and edges layered by
 * brightness rather than color.
 *
 * The difference from `Terax` (the default neutral gray) is contrast: Terax is a
 * comfortable grayscale, while Verta presses the base down to almost pure black and
 * pushes the accent up to pure white, closer to the icon itself — clean and sharp.
 * Both stay in the list on purpose, so people can pick whichever they like.
 *
 * **Dark and light share one palette**: the icon is black, and the light appearance
 * does not flip it to black-on-white either — choosing this theme means a black UI.
 * (An earlier version inverted the icon for light mode, which did not match
 * expectations and was dropped.)
 *
 * The 16 ANSI colors do not go monochrome: in an all-gray terminal, added and
 * removed lines in `git diff`, log levels, and compile errors become
 * indistinguishable. These are **low-saturation but distinguishable** colors, so the
 * UI as a whole still reads as black and white.
 */
const COLORS: ThemeColors = {
  // The black in the icon is not pure black but a slightly cool near-black; sampled
  // from it.
  background: "#0b0b0d",
  foreground: "#f4f4f5",
  card: "#131316",
  cardForeground: "#f4f4f5",
  popover: "#17171a",
  popoverForeground: "#f4f4f5",
  // The V in the icon is pure white, and that is the accent color.
  primary: "#ffffff",
  primaryForeground: "#0b0b0d",
  secondary: "#1c1c20",
  secondaryForeground: "#ececee",
  muted: "#131316",
  mutedForeground: "#9a9aa2",
  accent: "#232328",
  accentForeground: "#f7f7f8",
  destructive: "#e08585",
  border: "#2a2a30",
  input: "#1a1a1e",
  ring: "#ffffff",
  sidebar: "#0e0e11",
  sidebarForeground: "#b6b6be",
  sidebarPrimary: "#ffffff",
  sidebarPrimaryForeground: "#0b0b0d",
  sidebarAccent: "#1c1c20",
  sidebarAccentForeground: "#f4f4f5",
  sidebarBorder: "#222228",
  sidebarRing: "#ffffff",
  // The icon is a rounded square, not a pill; a 1/4 radius fits it better than the
  // default.
  radius: "0.625rem",
};

const TERMINAL: TerminalPalette = {
  background: "#0b0b0d",
  foreground: "#f4f4f5",
  cursor: "#ffffff",
  cursorAccent: "#0b0b0d",
  selection: "rgba(255, 255, 255, 0.24)",
  ansi: [
    "#2e2e34",
    "#d98d8d",
    "#96c9a6",
    "#d9c489",
    "#8fb4de",
    "#c3a3d6",
    "#8dc6c2",
    "#b6b6be",
    "#56565e",
    "#eaa8a8",
    "#aed9bb",
    "#ecd9a2",
    "#a8c8ea",
    "#d5b9e2",
    "#a6dbd6",
    "#ffffff",
  ],
};

export const verta: Theme = {
  id: "verta",
  name: "Verta",
  description: "Near-black base with a pure white accent.",
  // The UI is black, so the editor stays dark too; otherwise the code area would be
  // white inside a black frame.
  editorTheme: { dark: "github-dark", light: "github-dark" },
  variants: {
    dark: { colors: COLORS, terminal: TERMINAL },
    light: { colors: COLORS, terminal: TERMINAL },
  },
};