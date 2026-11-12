import type { Theme } from "../types";

/**
 * Carbon fiber: a 2/2 twill pressed onto a deep graphite base, with panels that
 * stay solid.
 *
 * It used to carry the weave itself, as a texture the surface layer painted under
 * the whole interface - two palettes, two carved directions, a tile computed from
 * the geometry of a twill. It is colours now, like every other theme: one look per
 * palette, no texture of its own, so what a theme decides is what a theme has
 * always decided here - the colours - and the material is the shape axis' business.
 *
 * The graphite and the silver-cyan sheen are what is left of the fiber, and they
 * are what the theme was ever recognised by from a distance.
 */
export const carbonWeave: Theme = {
  id: "carbon-weave",
  name: "Carbon Fiber",
  description: "Graphite with a silver-cyan sheen.",
  editorTheme: { dark: "github-dark", light: "github-light" },
  variants: {
    dark: {
      colors: {
        background: "#16181a",
        foreground: "#e3e6e8",
        card: "#1c1f22",
        cardForeground: "#e3e6e8",
        popover: "#1e2225",
        popoverForeground: "#e3e6e8",
        // The carbon-fiber sheen: a cyan-leaning silver rather than a saturated
        // accent.
        primary: "#a8bcc6",
        primaryForeground: "#16181a",
        secondary: "#23272b",
        secondaryForeground: "#e3e6e8",
        muted: "#1c1f22",
        mutedForeground: "#8f979d",
        accent: "#282d31",
        accentForeground: "#eef1f3",
        destructive: "#d98f8f",
        border: "#2b3034",
        input: "#202427",
        ring: "#a8bcc6",
        sidebar: "#17191b",
        sidebarForeground: "#b3babe",
        sidebarPrimary: "#a8bcc6",
        sidebarPrimaryForeground: "#16181a",
        sidebarAccent: "#22262a",
        sidebarAccentForeground: "#e3e6e8",
        sidebarBorder: "#24282c",
        sidebarRing: "#a8bcc6",
        radius: "0.375rem",
      },
      // Carbon fiber is not glass: panes stay solid and the texture only covers
      // the gaps between panes and the frame. A honeycomb showing under text just
      // looks dirty.
      terminal: {
        background: "#16181a",
        foreground: "#e3e6e8",
        cursor: "#a8bcc6",
        cursorAccent: "#16181a",
        selection: "rgba(168, 188, 198, 0.28)",
        ansi: [
          "#2b3034",
          "#d98f8f",
          "#9cc4a8",
          "#d8c186",
          "#8fb4d6",
          "#c0a2cd",
          "#8ec2c6",
          "#b3babe",
          "#4f565b",
          "#e8abab",
          "#b0d6bc",
          "#e8d5a0",
          "#a6c8e8",
          "#d4bbdd",
          "#a4d4d8",
          "#f2f5f6",
        ],
      },
    },
    light: {
      colors: {
        background: "#f4f5f5",
        foreground: "#22262a",
        card: "#eaebec",
        cardForeground: "#22262a",
        popover: "#fbfcfc",
        popoverForeground: "#22262a",
        primary: "#41565f",
        primaryForeground: "#fbfcfc",
        secondary: "#e3e5e6",
        secondaryForeground: "#22262a",
        muted: "#eaebec",
        mutedForeground: "#616a70",
        accent: "#dde0e2",
        accentForeground: "#22262a",
        destructive: "#9c4a4a",
        border: "#d7dadc",
        input: "#e8eaea",
        ring: "#41565f",
        sidebar: "#eff1f1",
        sidebarForeground: "#2e3438",
        sidebarPrimary: "#41565f",
        sidebarPrimaryForeground: "#fbfcfc",
        sidebarAccent: "#e3e5e6",
        sidebarAccentForeground: "#22262a",
        sidebarBorder: "#d7dadc",
        sidebarRing: "#41565f",
        radius: "0.375rem",
      },
      // As above: solid, opaque panes. The terminal's colour has to be the panes' own: the workspace
      // paints `--background` behind the terminal canvas, so a terminal one shade lighter showed as a
      // rectangle inside the workspace - invisible nowhere more clearly than in the shape that merges
      // the three regions, where there is no border to hide the step. `terminal-pane-tone.test.ts`
      // holds every built-in theme to it.
      terminal: {
        background: "#f4f5f5",
        foreground: "#22262a",
        cursor: "#41565f",
        cursorAccent: "#fbfcfc",
        selection: "rgba(65, 86, 95, 0.2)",
        ansi: [
          "#2e3438",
          "#9c4a4a",
          "#3f6b4a",
          "#7a6428",
          "#2f5f8f",
          "#6b4a7a",
          "#2f6d6f",
          "#616a70",
          "#474e53",
          "#b25b5b",
          "#4f7d5a",
          "#94702c",
          "#3f70a0",
          "#835a89",
          "#3d7f82",
          "#22262a",
        ],
      },
    },
  },
};
