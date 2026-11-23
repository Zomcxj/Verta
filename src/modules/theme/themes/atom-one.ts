import type { Theme } from "../types";

/**
 * Atom One: the One Dark palette, with One Light for the light appearance.
 *
 * This file used to hold Carbon Fiber, which painted a graphite base with a silver-cyan sheen. That
 * material is the `carbon` shape now, and a theme named after it said the same thing twice - the
 * settings page offered "Carbon Fiber" as a colour scheme while "Carbon fiber" sat two rows below it
 * on the shape axis. So the slot carries a palette instead: a scheme that is not in this list, and
 * whose name says which one it is.
 *
 * The id stays `carbon-weave`. Ids are what a stored preference and `settings.themeId` identify a
 * theme by, and renaming one would drop everyone who picked it back to the default; display name and
 * id are separate things, the same arrangement the brand theme has under `verta-default`.
 *
 * Dark is the One Dark palette: `#282c34` behind `#abb2bf`, with the blue `#61afef` as the accent.
 * Light is One Light: `#fafafa` behind `#383a42`, with `#4078f2`. Both keep the scheme's own hues
 * for the ANSI slots - six of them, not a monochrome ramp - so a diff's red and green, a log's
 * yellow and a prompt's cyan stay apart from each other.
 */
export const atomOne: Theme = {
  id: "carbon-weave",
  name: "Atom One",
  description: "Cool blue-grey dark, paper-white light.",
  // The editor theme named for this palette is already shipped: `atomone` is Atom One Dark.
  // One Light has no counterpart of its own here, so the light appearance takes GitHub's.
  editorTheme: { dark: "atomone", light: "github-light" },
  variants: {
    dark: {
      colors: {
        background: "#282c34",
        foreground: "#abb2bf",
        card: "#2c313a",
        cardForeground: "#abb2bf",
        popover: "#2f343e",
        popoverForeground: "#abb2bf",
        primary: "#61afef",
        primaryForeground: "#282c34",
        secondary: "#333842",
        secondaryForeground: "#d7dae0",
        muted: "#2c313a",
        mutedForeground: "#8b949e",
        accent: "#3a3f4b",
        accentForeground: "#e6e9ef",
        destructive: "#e06c75",
        border: "#3b4048",
        input: "#31353f",
        ring: "#61afef",
        sidebar: "#21252b",
        sidebarForeground: "#9da5b4",
        sidebarPrimary: "#61afef",
        sidebarPrimaryForeground: "#282c34",
        sidebarAccent: "#2c313a",
        sidebarAccentForeground: "#abb2bf",
        sidebarBorder: "#2f333d",
        sidebarRing: "#61afef",
        radius: "0.5rem",
      },
      // The terminal's background has to be the panes' own: the workspace paints `--background`
      // behind the terminal canvas, so a terminal a shade off shows as a rectangle inside it.
      // `terminal-pane-tone.test.ts` holds every built-in theme to it.
      terminal: {
        background: "#282c34",
        foreground: "#abb2bf",
        cursor: "#61afef",
        cursorAccent: "#282c34",
        selection: "rgba(97, 175, 239, 0.28)",
        ansi: [
          "#3b4048",
          "#e06c75",
          "#98c379",
          "#e5c07b",
          "#61afef",
          "#c678dd",
          "#56b6c2",
          "#abb2bf",
          "#5c6370",
          "#e88b93",
          "#a9d1a2",
          "#ecc98e",
          "#84c1f4",
          "#d49ae6",
          "#78c7d1",
          "#ffffff",
        ],
      },
    },
    light: {
      colors: {
        background: "#fafafa",
        foreground: "#383a42",
        card: "#f0f0f1",
        cardForeground: "#383a42",
        popover: "#ffffff",
        popoverForeground: "#383a42",
        primary: "#4078f2",
        primaryForeground: "#ffffff",
        secondary: "#eaebec",
        secondaryForeground: "#383a42",
        muted: "#f0f0f1",
        mutedForeground: "#5f6368",
        accent: "#e5e6e7",
        accentForeground: "#2b2d31",
        destructive: "#e45649",
        border: "#dcdee0",
        input: "#ececee",
        ring: "#4078f2",
        sidebar: "#f3f4f4",
        sidebarForeground: "#4f535a",
        sidebarPrimary: "#4078f2",
        sidebarPrimaryForeground: "#ffffff",
        sidebarAccent: "#eaebec",
        sidebarAccentForeground: "#383a42",
        sidebarBorder: "#e2e3e5",
        sidebarRing: "#4078f2",
        radius: "0.5rem",
      },
      // As above: the panes' own tone, not a shade of it.
      terminal: {
        background: "#fafafa",
        foreground: "#383a42",
        cursor: "#4078f2",
        cursorAccent: "#ffffff",
        selection: "rgba(64, 120, 242, 0.2)",
        ansi: [
          "#383a42",
          "#e45649",
          "#50a14f",
          "#c18401",
          "#4078f2",
          "#a626a4",
          "#0184bc",
          "#696c77",
          "#8b8d94",
          "#c94a3e",
          "#3f8a3f",
          "#a06c00",
          "#2f63d4",
          "#8a1f88",
          "#016a99",
          "#383a42",
        ],
      },
    },
  },
};
