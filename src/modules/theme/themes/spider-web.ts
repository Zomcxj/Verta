import type { Theme } from "../types";

/**
 * 一张极淡的蛛网：同心多边形 + 从中心放射的丝。
 *
 * 编成 data-URI SVG 而不是画在 canvas / DOM 上：它是一张静态图，浏览器只在需要时
 * 光栅化一次，切主题、缩放都只是重绘一次背景，不用 React 参与。线本身用
 * `currentColor`，颜色由 `stroke` 显式写上（data-URI 里拿不到页面变量）。
 *
 * 几何：中心 `(60,60)`，半径 12→54 每 7 一格，八条丝（每 45° 一条），
 * 每条丝在内圈的顶点之间连一条弦 —— 这样看起来才是「网」，而不是一摞圆环。
 */
function webSvg(stroke: string): string {
  const rings = [12, 19, 26, 33, 40, 47, 54];
  const spokes = 8;
  const point = (radius: number, index: number): [number, number] => {
    const angle = (Math.PI * 2 * index) / spokes - Math.PI / 2;
    return [
      Math.round((60 + radius * Math.cos(angle)) * 100) / 100,
      Math.round((60 + radius * Math.sin(angle)) * 100) / 100,
    ];
  };
  const parts: string[] = [];
  for (const radius of rings) {
    const points = Array.from({ length: spokes }, (_, index) =>
      point(radius, index).join(","),
    ).join(" ");
    parts.push(`<polygon points="${points}"/>`);
  }
  for (let index = 0; index < spokes; index++) {
    const [x, y] = point(54, index);
    parts.push(`<line x1="60" y1="60" x2="${x}" y2="${y}"/>`);
  }
  // 中心那一小撮丝，让上下两层叠起来时看得出是同一个中心。
  for (let index = 0; index < spokes; index++) {
    const [x, y] = point(12, index);
    const [ox, oy] = point(6, index);
    parts.push(`<line x1="${ox}" y1="${oy}" x2="${x}" y2="${y}"/>`);
  }
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">`,
    `<g fill="none" stroke="${stroke}" stroke-width="1" stroke-linecap="round">`,
    parts.join(""),
    `</g></svg>`,
  ].join("");
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * 蜘蛛网纹路：深色的夜蓝底，上面一层几乎看不见的蛛网，深浅随主题切换。
 *
 * 网要淡到「看第二眼才发现」——它负责让空白处不空，而不是抢内容。
 * `blend: soft-light` 让同一张网在深色底上提亮、在浅色底上压暗，不用写两份颜色。
 */
export const spiderWeb: Theme = {
  id: "spider-web",
  name: "蜘蛛网纹路",
  description: "夜蓝底上一层极淡的蛛网，安静但不空。",
  editorTheme: { dark: "github-dark", light: "github-light" },
  variants: {
    dark: {
      colors: {
        background: "oklch(0.19 0.022 275)",
        foreground: "oklch(0.93 0.012 275)",
        card: "oklch(0.235 0.025 275)",
        cardForeground: "oklch(0.93 0.012 275)",
        popover: "oklch(0.245 0.025 275)",
        popoverForeground: "oklch(0.93 0.012 275)",
        primary: "oklch(0.76 0.1 285)",
        primaryForeground: "oklch(0.19 0.03 275)",
        secondary: "oklch(0.3 0.025 275)",
        secondaryForeground: "oklch(0.9 0.012 275)",
        muted: "oklch(0.27 0.02 275)",
        mutedForeground: "oklch(0.68 0.02 275)",
        accent: "oklch(0.33 0.035 280)",
        accentForeground: "oklch(0.95 0.01 275)",
        destructive: "oklch(0.62 0.18 20)",
        border: "oklch(0.36 0.025 278)",
        input: "oklch(0.27 0.02 275)",
        ring: "oklch(0.76 0.1 285 / 0.7)",
        sidebar: "oklch(0.175 0.022 275)",
        sidebarForeground: "oklch(0.9 0.012 275)",
        sidebarPrimary: "oklch(0.76 0.1 285)",
        sidebarPrimaryForeground: "oklch(0.19 0.03 275)",
        sidebarAccent: "oklch(0.27 0.025 280)",
        sidebarAccentForeground: "oklch(0.93 0.012 275)",
        sidebarBorder: "oklch(0.32 0.022 278)",
        sidebarRing: "oklch(0.76 0.1 285 / 0.7)",
        radius: "0.5rem",
      },
      surface: {
        background: "oklch(0.17 0.026 278)",
        image: webSvg("oklch(0.72 0.05 285)"),
        repeat: "repeat",
        size: "460px 460px",
        // 要看得见但抢不了戏：0.16 + soft-light 实测在深色底上几乎消失，调到这里刚好。
        opacity: 0.42,
        blend: "soft-light",
      },
      terminal: {
        background: "oklch(0.175 0.022 275)",
        foreground: "oklch(0.92 0.012 275)",
        cursor: "oklch(0.76 0.1 285)",
        cursorAccent: "oklch(0.19 0.03 275)",
        selection: "oklch(0.76 0.1 285 / 0.28)",
        ansi: [
          "oklch(0.3 0.02 275)",
          "oklch(0.68 0.17 20)",
          "oklch(0.74 0.13 150)",
          "oklch(0.82 0.12 85)",
          "oklch(0.7 0.12 260)",
          "oklch(0.72 0.13 320)",
          "oklch(0.74 0.1 200)",
          "oklch(0.87 0.012 275)",
          "oklch(0.44 0.02 275)",
          "oklch(0.78 0.15 20)",
          "oklch(0.83 0.12 150)",
          "oklch(0.9 0.11 85)",
          "oklch(0.8 0.11 260)",
          "oklch(0.82 0.11 320)",
          "oklch(0.84 0.09 200)",
          "oklch(0.97 0.006 275)",
        ],
      },
    },
    light: {
      colors: {
        background: "oklch(0.975 0.006 285)",
        foreground: "oklch(0.26 0.02 280)",
        card: "oklch(0.995 0.003 285)",
        cardForeground: "oklch(0.26 0.02 280)",
        popover: "oklch(1 0 0)",
        popoverForeground: "oklch(0.26 0.02 280)",
        primary: "oklch(0.5 0.11 285)",
        primaryForeground: "oklch(0.99 0.004 285)",
        secondary: "oklch(0.945 0.01 285)",
        secondaryForeground: "oklch(0.3 0.02 280)",
        muted: "oklch(0.955 0.008 285)",
        mutedForeground: "oklch(0.5 0.02 280)",
        accent: "oklch(0.935 0.018 290)",
        accentForeground: "oklch(0.28 0.03 280)",
        destructive: "oklch(0.58 0.19 22)",
        border: "oklch(0.88 0.014 285)",
        input: "oklch(0.97 0.008 285)",
        ring: "oklch(0.5 0.11 285 / 0.5)",
        sidebar: "oklch(0.965 0.008 285)",
        sidebarForeground: "oklch(0.28 0.02 280)",
        sidebarPrimary: "oklch(0.5 0.11 285)",
        sidebarPrimaryForeground: "oklch(0.99 0.004 285)",
        sidebarAccent: "oklch(0.93 0.016 290)",
        sidebarAccentForeground: "oklch(0.28 0.02 280)",
        sidebarBorder: "oklch(0.89 0.014 285)",
        sidebarRing: "oklch(0.5 0.11 285 / 0.5)",
        radius: "0.5rem",
      },
      surface: {
        background: "oklch(0.965 0.01 285)",
        image: webSvg("oklch(0.42 0.06 285)"),
        repeat: "repeat",
        size: "460px 460px",
        opacity: 0.22,
        blend: "multiply",
      },
      terminal: {
        background: "oklch(0.99 0.004 285)",
        foreground: "oklch(0.27 0.02 280)",
        cursor: "oklch(0.5 0.11 285)",
        cursorAccent: "oklch(0.99 0.004 285)",
        selection: "oklch(0.5 0.11 285 / 0.2)",
        ansi: [
          "oklch(0.32 0.02 280)",
          "oklch(0.55 0.19 22)",
          "oklch(0.5 0.14 150)",
          "oklch(0.6 0.13 85)",
          "oklch(0.5 0.14 260)",
          "oklch(0.52 0.16 320)",
          "oklch(0.5 0.1 200)",
          "oklch(0.62 0.012 280)",
          "oklch(0.44 0.02 280)",
          "oklch(0.6 0.19 22)",
          "oklch(0.56 0.14 150)",
          "oklch(0.68 0.13 85)",
          "oklch(0.56 0.14 260)",
          "oklch(0.58 0.16 320)",
          "oklch(0.56 0.1 200)",
          "oklch(0.3 0.012 280)",
        ],
      },
    },
  },
};
