import type { Theme } from "../types";

/**
 * Hexagonal grid, **computed from the geometry** rather than copied from a
 * ready-made pattern file.
 *
 * A regular hexagon standing on a point is `w` wide and `h = w * 2 / sqrt(3)`
 * tall, with adjacent columns offset by half. For a seamless tile the cell is
 * exactly `w` wide and `1.5 * h / 2` tall, so edges line up naturally when tiles
 * meet on all sides. Only the outline ring is drawn here, never a fill, so it
 * reads as a mesh rather than blocks.
 */
function hexGrid(stroke: string, opacity: number): string {
  const w = 14;
  const h = Math.round((w * 2) / Math.sqrt(3) * 100) / 100; // ≈30.02
  const tileH = Math.round(h * 1.5 * 100) / 100; // rows offset by 1.5h
  const r = w / 2;
  // The six vertices of a pointy-top hexagon, centered on (0,0).
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    pts.push(
      `${Math.round(r * Math.cos(a) * 100) / 100},${Math.round(r * Math.sin(a) * 100) / 100}`,
    );
  }
  const hex = (cx: number, cy: number) =>
    `<polygon points="${pts.join(" ")}" transform="translate(${cx} ${cy})"/>`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${tileH}" viewBox="0 0 ${w} ${tileH}">`,
    `<g fill="none" stroke="${stroke}" stroke-opacity="${opacity}" stroke-width="0.8">`,
    hex(w / 2, h / 2),
    hex(0, h / 2 + h / 2),
    hex(w, h / 2 + h / 2),
    "</g></svg>",
  ].join("");
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}


/**
 * **The cell has to stay small**: 26px hexagons tile into a faint texture at a
 * glance, while a large cell turns into a pattern that fights the text. That was
 * the mistake in the first attempt: a 40px fretwork under a 520px grid turned
 * the whole UI to mush.
 */

/**
 * Carbon fiber: a very fine honeycomb weave pressed onto a deep graphite base,
 * with panels that stay solid.
 *
 * Two things together make it read as carbon fiber:
 * 1. the weave itself is small (13×22.75), so at a glance it is only "there is a
 *    fine texture";
 * 2. the panels are opaque and the weave is drawn on the surface layer under
 *    them, so it shows in the frame between the panels; a weave showing *under*
 *    the text would just look dirty.
 *
 * The weave's visibility comes from `soft-light` at a low opacity: on a dark
 * base, lifting it slightly is enough, while a solid colour would look like a
 * grid image pasted on.
 */
export const carbonWeave: Theme = {
  id: "carbon-weave",
  name: "Carbon Fiber",
  description: "Honeycomb weave over graphite.",
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
      surface: {
        background: "#16181a",
        image: hexGrid("#ffffff", 0.32),
        repeat: "repeat",
        // 13×22.75 is 28×49 scaled proportionally; change the ratio and the honeycomb
        // gets gaps.
        size: "14px 24.25px",
        opacity: 0.3,
        blend: "soft-light",
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
      surface: {
        background: "#f4f5f5",
        // Light mode flips it: dark ink lines with `multiply`. It used to be white
        // lines with `multiply`: white is multiply's identity, so the texture never
        // showed no matter how it was tuned.
        //
        // Opacities are matched against the dark side: there white lines at
        // 0.32 × 0.3 (soft-light, lifting ~22 per channel); here ink lines at
        // 0.5 × 0.14 (multiply, darkening ~15 per channel). A dark base carries
        // contrast better than a light one, so the light side has to hold back
        // further to stay unobtrusive.
        image: hexGrid("#22262a", 0.5),
        repeat: "repeat",
        size: "14px 24.25px",
        opacity: 0.14,
        blend: "multiply",
      },
      // As above: solid, opaque panes.
      terminal: {
        background: "#fbfcfc",
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
