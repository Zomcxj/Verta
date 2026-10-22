import type { Theme } from "../types";

/** 一张极淡的蛛网：同心多边形 + 从中心放射的丝。 */
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
  for (let index = 0; index < spokes; index++) {
    const [x, y] = point(12, index);
    const [ox, oy] = point(6, index);
    parts.push(`<line x1="${ox}" y1="${oy}" x2="${x}" y2="${y}"/>`);
  }
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">',
    `<g fill="none" stroke="${stroke}" stroke-width="1" stroke-linecap="round">`,
    parts.join(""),
    "</g></svg>",
  ].join("");
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * Terax Web —— 玄青底的冷调界面，一层几乎看不见的蛛网在上面。
 *
 * 「Terax」的读感偏冷静、带一点金属与网的意味，所以这套走冷色而不是暖色，
 * 跟 `Terax Warm` 正好配成一对：一个暖、一个冷，两套都是完整的界面配色，不靠纹理撑场面。
 *
 * 蛛网只是底纹：`soft-light` 让它跟着底色走（深色底上提亮、浅色底上压暗），
 * 所以两个模式只用同一种画法，不需要写两份颜色。
 */
export const teraxWeb: Theme = {
  id: "terax-web",
  name: "Terax Web",
  description: "玄青冷色的深界面，底下压着一层极淡的蛛网。",
  editorTheme: { dark: "github-dark", light: "github-light" },
  variants: {
    dark: {
      colors: {
        background: "#0f1417",
        foreground: "#dde4e6",
        card: "#151b1f",
        cardForeground: "#dde4e6",
        popover: "#161d21",
        popoverForeground: "#dde4e6",
        primary: "#7fb3a8",
        primaryForeground: "#0f1417",
        secondary: "#1d262b",
        secondaryForeground: "#dde4e6",
        muted: "#161d21",
        mutedForeground: "#8a9aa0",
        accent: "#223035",
        accentForeground: "#e6edef",
        destructive: "#d99a9a",
        border: "#232e33",
        input: "#1b2429",
        ring: "#7fb3a8",
        sidebar: "#121719",
        sidebarForeground: "#aebcc1",
        sidebarPrimary: "#7fb3a8",
        sidebarPrimaryForeground: "#0f1417",
        sidebarAccent: "#1b2429",
        sidebarAccentForeground: "#dde4e6",
        sidebarBorder: "#1f282d",
        sidebarRing: "#7fb3a8",
        radius: "0.375rem",
      },
      surface: {
        background: "#0f1417",
        image: webSvg("#8fc4bb"),
        repeat: "repeat",
        size: "440px 440px",
        // 0.16 在深色底上实测看不见；0.3 是「看第二眼才发现」的那一档。
        opacity: 0.3,
        blend: "soft-light",
      },
      terminal: {
        background: "#0f1417",
        foreground: "#dde4e6",
        cursor: "#7fb3a8",
        cursorAccent: "#0f1417",
        selection: "rgba(127, 179, 168, 0.3)",
        ansi: [
          "#2a3439",
          "#d99a9a",
          "#93c4a8",
          "#d6c48e",
          "#8fb4d6",
          "#c3a2c9",
          "#7fb3a8",
          "#aebcc1",
          "#4a565c",
          "#e9b3b3",
          "#a9d8bd",
          "#e8d7a5",
          "#a6c8e8",
          "#d8bbdd",
          "#9bcbc0",
          "#f0f6f7",
        ],
      },
    },
    light: {
      colors: {
        background: "#f4f7f7",
        foreground: "#1e2629",
        card: "#eaefef",
        cardForeground: "#1e2629",
        popover: "#fbfdfd",
        popoverForeground: "#1e2629",
        primary: "#2f6d63",
        primaryForeground: "#fbfdfd",
        secondary: "#e2e9e9",
        secondaryForeground: "#1e2629",
        muted: "#eaefef",
        mutedForeground: "#5d6b70",
        accent: "#dde6e6",
        accentForeground: "#1e2629",
        destructive: "#9c4a4a",
        border: "#d5dede",
        input: "#e8eeee",
        ring: "#2f6d63",
        sidebar: "#eff4f4",
        sidebarForeground: "#2c363a",
        sidebarPrimary: "#2f6d63",
        sidebarPrimaryForeground: "#fbfdfd",
        sidebarAccent: "#e2e9e9",
        sidebarAccentForeground: "#1e2629",
        sidebarBorder: "#d5dede",
        sidebarRing: "#2f6d63",
        radius: "0.375rem",
      },
      surface: {
        background: "#f4f7f7",
        image: webSvg("#2f6d63"),
        repeat: "repeat",
        size: "440px 440px",
        opacity: 0.12,
        blend: "multiply",
      },
      terminal: {
        background: "#fbfdfd",
        foreground: "#1e2629",
        cursor: "#2f6d63",
        cursorAccent: "#fbfdfd",
        selection: "rgba(47, 109, 99, 0.2)",
        ansi: [
          "#2c363a",
          "#9c4a4a",
          "#2f6d63",
          "#7a6428",
          "#2f5f8f",
          "#6b4a7a",
          "#2f6d7a",
          "#5d6b70",
          "#475456",
          "#b25b5b",
          "#3d8276",
          "#946b3f",
          "#3f70a0",
          "#835a89",
          "#3d7f8c",
          "#1e2629",
        ],
      },
    },
  },
};
