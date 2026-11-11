import type { Theme } from "../types";

/**
 * Carbon fibre: a 2/2 twill, **computed from the geometry** rather than copied
 * from a ready-made pattern file.
 *
 * A twill is not a grid of shapes. It is tows - flat bundles of filaments - woven
 * over two and under two, so the tows of one direction step sideways by one every
 * two rows and the crossings walk diagonally. What the eye reads as carbon fibre
 * is mostly the bundles rather than the crossings: a tow is round, so it carries a
 * highlight along its crest and falls away into shadow at its edges.
 *
 * The tile is therefore four tows square - the period of the weave - and each cell
 * is a tow painted with a gradient that runs along its length. Two gradients cover
 * both directions, and the shadow where tows meet is the dark end of those same
 * gradients, so no separate seam lines are needed. The tile and the size it is
 * drawn at are returned together: a size that does not match the tile leaves gaps
 * between repeats, which the honeycomb that came before this had to warn about.
 *
 * The scale is the whole trick. The texture is only ever seen in the bands of
 * chrome between the panes - a header 40px tall, a gutter 8px wide - so a weave
 * that reads as fabric is one whose tows are a few pixels wide: 3px tows give a
 * 12px tile, which is three rows inside the header and just over one row inside a
 * gutter. Finer turns to noise, coarser turns to a tablecloth.
 */
export function twillWeave(options: {
  /** Colour of the light running along the crest of a tow. */
  sheen: string;
  /** Colour of the shadow where two tows meet. */
  seam: string;
  /** How strong the crest is, before the surface layer's own opacity. */
  sheenOpacity: number;
  /** How deep the shadow between tows is. */
  seamOpacity: number;
  /** Width of one tow, in pixels. The tile is four tows across and four down. */
  tow: number;
}): { image: string; size: string } {
  const { sheen, seam, sheenOpacity, seamOpacity, tow } = options;
  const size = tow * 4;
  const cells: Array<{ x: number; y: number; warpFacing: boolean }> = [];
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      // The 2/2 twill: the warp shows for two tows and hides for two, and the block
      // moves one tow sideways every row - which is what makes the diagonal.
      cells.push({ x: x * tow, y: y * tow, warpFacing: (x - y + 4) % 4 < 2 });
    }
  }
  // A gradient across the tow gives it a crest: shadow at both edges, light along
  // the middle, and a slightly softer fall on the far side so the crest is not
  // dead centre.
  const gradient = (id: string, axis: "x" | "y") =>
    [
      `<linearGradient id="${id}" x1="0" y1="0" x2="${axis === "x" ? 1 : 0}" y2="${axis === "x" ? 0 : 1}">`,
      `<stop offset="0" stop-color="${seam}" stop-opacity="${seamOpacity}"/>`,
      `<stop offset="0.42" stop-color="${sheen}" stop-opacity="${sheenOpacity}"/>`,
      `<stop offset="0.67" stop-color="${sheen}" stop-opacity="${sheenOpacity * 0.55}"/>`,
      `<stop offset="1" stop-color="${seam}" stop-opacity="${seamOpacity * 0.7}"/>`,
      "</linearGradient>",
    ].join("");
  const weave = cells
    .map(
      (cell) =>
        `<rect x="${cell.x}" y="${cell.y}" width="${tow}" height="${tow}" fill="url(#${cell.warpFacing ? "warp" : "weft"})"/>`,
    )
    .join("");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<defs>${gradient("warp", "x")}${gradient("weft", "y")}</defs>`,
    weave,
    "</svg>",
  ].join("");
  return { image: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`, size: `${size}px ${size}px` };
}

/**
 * Carbon fiber: a 2/2 twill pressed onto a deep graphite base, with panels that
 * stay solid.
 *
 * Two things together make it read as carbon fiber:
 * 1. the tows are a few pixels wide, so at a glance there is only "there is a
 *    woven texture" - and it is only ever seen in the chrome, because the panels
 *    are opaque and the weave is drawn on the surface layer under them; a weave
 *    showing *under* the text would just look dirty;
 * 2. the lift comes from `soft-light` at a low opacity: on a dark base, raising it
 *    a little is enough, while a solid colour would look like an image pasted on.
 *
 * The light side flips the direction of the carve: the crest is white, which is
 * `multiply`'s identity, so what shows there is the shadow between the tows rather
 * than the light on them.
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
        // 3px tows: three rows of weave inside the 40px header, and one inside a gutter.
        ...twillWeave({
          tow: 3,
          sheen: "#ffffff",
          seam: "#000000",
          sheenOpacity: 0.34,
          seamOpacity: 0.3,
        }),
        repeat: "repeat",
        opacity: 0.34,
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
        // Light mode carves the same weave the other way round: the crest stays white,
        // which changes nothing under `multiply`, and the shadow between the tows is
        // drawn in ink. That is the same picture as the dark side - a weave you notice
        // only if you look at it - with the polarity the blend mode needs. It used to
        // be white lines with `multiply`, which is multiply's identity: the texture
        // never showed at all, no matter how it was tuned.
        //
        // Opacities are matched against the dark side: there a white crest at
        // 0.34 × 0.34 lifts a dark base; here ink seams at 0.5 × 0.16 darken a light
        // one. A dark base carries contrast better, so the light side holds back
        // further to stay unobtrusive.
        ...twillWeave({
          tow: 3,
          sheen: "#ffffff",
          seam: "#22262a",
          sheenOpacity: 1,
          seamOpacity: 0.5,
        }),
        repeat: "repeat",
        opacity: 0.16,
        blend: "multiply",
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
