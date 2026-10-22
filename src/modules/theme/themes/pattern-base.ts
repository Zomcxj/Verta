import type { Theme } from "../types";

/**
 * 六边形网格：**自己按几何算出来的**，不拷任何现成图案文件的路径。
 *
 * 一个正六边形（尖顶站立）宽 `w`、高 `h = w * 2 / sqrt(3)`，相邻两列错开半个；
 * 要无缝平铺，单元的宽正好是 `w`、高是 `1.5 * h / 2` —— 这样上下左右接上时
 * 边与边天然对齐。这里只画「描边」的那一圈，不填色，所以看起来是网不是块。
 */
function hexGrid(stroke: string, opacity: number): string {
  const w = 14;
  const h = Math.round((w * 2) / Math.sqrt(3) * 100) / 100; // ≈30.02
  const tileH = Math.round(h * 1.5 * 100) / 100; // 相邻两行错开 1.5h
  const r = w / 2;
  // 尖顶六边形的六个顶点（中心在 (0,0)）。
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
 * **格子必须够小**：26px 的六边形、平铺后远看只是一层细纹；格子一大就变成「图案」，
 * 会把字盖住。这是第一版犯过的错 —— 用 40px 的回纹再叠一张 520px 的网，整个界面糊成一片。
 */

/**
 * Carbon fiber: a very fine honeycomb weave pressed onto a deep graphite base,
 * with panels that stay solid.
 *
 * Two things together make it read as carbon fiber:
 * 1. the weave itself is small (13×22.75), so at a glance it is only "there is a
 *    fine texture";
 * 2. the panels are opaque and the weave is drawn on the surface layer under
 *    them, so it shows in the frame between the panels — a weave showing *under*
 *    the text would just look dirty.
 *
 * The weave's visibility comes from `soft-light` at a low opacity: on a dark
 * base, lifting it slightly is enough, while a solid colour would look like a
 * grid image pasted on.
 */
export const carbonWeave: Theme = {
  id: "carbon-weave",
  name: "Carbon Fiber",
  description: "Fine honeycomb weave over graphite; the panels stay solid.",
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
        // 碳纤维的「一抹亮」：偏青的银色，不用彩色主色。
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
        // 13×22.75 是 28×49 等比缩下来的：比例一动蜂窝就会有缝。
        size: "14px 24.25px",
        opacity: 0.3,
        blend: "soft-light",
      },
      // 碳纤维不是玻璃：面板保持实心，纹理只铺在面板之间的留白与框架上。
      // 透出来的蜂窝压在字底下反而显得脏。
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
        image: hexGrid("#ffffff", 0.32),
        repeat: "repeat",
        size: "14px 24.25px",
        opacity: 0.12,
        blend: "multiply",
      },
      // 同上：实心面板，不透明。
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
