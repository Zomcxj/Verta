import type { Theme } from "../types";

/**
 * Acrylic (the Windows 11 "Desktop Acrylic" material).
 *
 * This is not "paint a translucent layer ourselves": that only ever puts the
 * app's own colors underneath and ends up looking like a gray slab. Real acrylic
 * is drawn behind the window by DWM:
 * `DWMWA_SYSTEMBACKDROP_TYPE = DWMSBT_TRANSIENTWINDOW` (Microsoft's words: "For
 * Windows 11, this corresponds to Desktop Acrylic, also known as Background
 * Acrylic, in its brightest variant"), so the desktop is genuinely blurred,
 * noise-grain, and slightly brightened, and every transparent part of the window
 * shows it. Turning on this theme's `glass.desktop` makes `WindowVibrancyBridge`
 * switch to that native material.
 *
 * Colors follow Microsoft's acrylic recipe: a thin **tint** plus a highlight along
 * the top. Keep the tint low, since the desktop already provides most of the
 * texture; a heavy tint degrades acrylic into a plain translucent panel.
 *
 * **This theme deliberately has no `surface`**: a surface layer would paint a base
 * color over the whole window and cover exactly the DWM desktop blur behind it,
 * wasting the native material. Material plus the tint here is the whole look.
 *
 * It also deliberately avoids any CSS blur: `filter` would blur the UI itself,
 * and CSS filters that "sample behind" only see content in the same document and
 * **never reach the desktop**. See the note in `styles/globals.css`.
 */
export const acrylic: Theme = {
  id: "acrylic",
  name: "Acrylic",
  description: "Frosted glass with the desktop showing through.",
  // The material is the `glass` shape now, and this theme is its own colours plus a suggestion of
  // it: a stored `themeId: "acrylic"` keeps working and keeps looking like acrylic, without acrylic
  // being a thing a theme has to be.
  shape: "glass",
  editorTheme: { dark: "github-dark", light: "github-light" },
  variants: {
    dark: {
      colors: {
        background: "#1f2429",
        foreground: "#f2f5f7",
        card: "#262c32",
        cardForeground: "#f2f5f7",
        popover: "#2b3239",
        popoverForeground: "#f2f5f7",
        primary: "#8bb8d8",
        primaryForeground: "#14181c",
        secondary: "#2c333a",
        secondaryForeground: "#eef2f5",
        muted: "#262c32",
        mutedForeground: "#a8b4bd",
        accent: "#333b43",
        accentForeground: "#f4f7f9",
        destructive: "#e08b8b",
        border: "#3a434c",
        input: "#2a3138",
        ring: "#8bb8d8",
        sidebar: "#232930",
        sidebarForeground: "#c3ced6",
        sidebarPrimary: "#8bb8d8",
        sidebarPrimaryForeground: "#14181c",
        sidebarAccent: "#2c333a",
        sidebarAccentForeground: "#eef2f5",
        sidebarBorder: "#333b43",
        sidebarRing: "#8bb8d8",
        radius: "0.5rem",
      },
      glass: {
        // Thin tint: the desktop does most of the work. Slightly heavier in dark
        // mode so a light desktop does not wash the dark theme out.
        frame: 0.24,
        pane: 0.28,
        edge: 0.3,
        sheen: 0.12,
        desktop: true,
      },
      terminal: {
        // alpha 0 = the terminal paints no base color of its own, so its area is as
        // see-through as the surrounding panes and the desktop blur shows inside it
        // too (color blocks a TUI sets stay opaque: see the shader).
        background: "rgba(21, 27, 32, 0)",
        foreground: "#eef2f5",
        cursor: "#8bb8d8",
        cursorAccent: "#14181c",
        selection: "rgba(139, 184, 216, 0.3)",
        ansi: [
          "#39424a",
          "#e08b8b",
          "#8fd0a8",
          "#e6cd91",
          "#8bb8d8",
          "#c3a6e0",
          "#87cfd4",
          "#c3ced6",
          "#59636c",
          "#f0a6a6",
          "#a5e6c0",
          "#f2dcab",
          "#a8d6f4",
          "#d8c2ee",
          "#a2e2e6",
          "#f6fafc",
        ],
      },
    },
    light: {
      colors: {
        // Light acrylic: panes are a very pale white resting on the desktop blur
        // underneath.
        background: "#f3f6f8",
        foreground: "#1a1f24",
        card: "#ffffff",
        cardForeground: "#1a1f24",
        popover: "#ffffff",
        popoverForeground: "#1a1f24",
        primary: "#2d6f9e",
        primaryForeground: "#ffffff",
        secondary: "#e8eef2",
        secondaryForeground: "#1a1f24",
        muted: "#eef2f5",
        mutedForeground: "#58636d",
        accent: "#dde6ec",
        accentForeground: "#1a1f24",
        destructive: "#b25555",
        border: "#ccd8e0",
        input: "#eef2f5",
        ring: "#2d6f9e",
        sidebar: "#f7fafc",
        sidebarForeground: "#28313a",
        sidebarPrimary: "#2d6f9e",
        sidebarPrimaryForeground: "#ffffff",
        sidebarAccent: "#e8eef2",
        sidebarAccentForeground: "#1a1f24",
        sidebarBorder: "#ccd8e0",
        sidebarRing: "#2d6f9e",
        radius: "0.5rem",
      },
      glass: {
        // Light mode can let more desktop through: even a thin white pane still
        // holds text.
        frame: 0.3,
        pane: 0.34,
        edge: 0.6,
        sheen: 0.2,
        desktop: true,
      },
      terminal: {
        // Same as above: light mode also leaves this layer fully transparent.
        background: "rgba(255, 255, 255, 0)",
        foreground: "#1a1f24",
        cursor: "#2d6f9e",
        cursorAccent: "#ffffff",
        selection: "rgba(45, 111, 158, 0.2)",
        ansi: [
          "#28313a",
          "#b25555",
          "#2f7f63",
          "#8a6f24",
          "#2f6ba8",
          "#7a4f9c",
          "#2b7a86",
          "#58636d",
          "#495260",
          "#c96a6a",
          "#3d9276",
          "#a08234",
          "#3d7cbb",
          "#8f63b1",
          "#3a8d9a",
          "#1a1f24",
        ],
      },
    },
  },
};
