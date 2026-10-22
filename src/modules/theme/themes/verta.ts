import type { Theme } from "../types";

/**
 * Verta —— 应用图标就是一张「黑底白 V」，所以这套主题的配色直接照图标来：
 * 近黑的底、纯白当强调色、边界靠亮度分层而不是靠彩色。
 *
 * 跟 `Terax`（默认的中性灰）的区别在于「对比度」：Terax 是舒适的灰阶，
 * Verta 把底压到接近纯黑、把强调色提到纯白，更像那个图标本身 —— 干净、锐利。
 * 两者刻意都留在列表里，谁喜欢哪种就去选哪种。
 *
 * ANSI 那 16 色不跟着做黑白：终端里如果全是灰阶，`git diff` 的增删、日志级别、
 * 编译错误就分不出来了。这里用一组**低饱和但可辨**的颜色，整体仍像黑白界面。
 */
export const verta: Theme = {
  id: "verta",
  name: "Verta",
  description:
    "Black and white, taken from the app icon: a near-black base and a pure-white accent.",
  editorTheme: { dark: "github-dark", light: "github-light" },
  variants: {
    dark: {
      colors: {
        // 图标那个黑不是纯黑，是带一点冷调的近黑；照它取。
        background: "#0b0b0d",
        foreground: "#f4f4f5",
        card: "#131316",
        cardForeground: "#f4f4f5",
        popover: "#17171a",
        popoverForeground: "#f4f4f5",
        // 图标里的 V 是纯白：强调色就是它。
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
        // 图标是圆角方块，但不是药丸；1/4 圆角比默认更贴它。
        radius: "0.625rem",
      },
      terminal: {
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
      },
    },
    light: {
      colors: {
        // 浅色就是把图标反过来：白底、黑 V。
        background: "#ffffff",
        foreground: "#0b0b0d",
        card: "#f4f4f5",
        cardForeground: "#0b0b0d",
        popover: "#ffffff",
        popoverForeground: "#0b0b0d",
        primary: "#0b0b0d",
        primaryForeground: "#ffffff",
        secondary: "#ebebed",
        secondaryForeground: "#17171a",
        muted: "#f4f4f5",
        mutedForeground: "#63636b",
        accent: "#e6e6e9",
        accentForeground: "#0b0b0d",
        destructive: "#b25555",
        border: "#dcdce0",
        input: "#f0f0f2",
        ring: "#0b0b0d",
        sidebar: "#fafafa",
        sidebarForeground: "#2c2c33",
        sidebarPrimary: "#0b0b0d",
        sidebarPrimaryForeground: "#ffffff",
        sidebarAccent: "#ebebed",
        sidebarAccentForeground: "#0b0b0d",
        sidebarBorder: "#dcdce0",
        sidebarRing: "#0b0b0d",
        radius: "0.625rem",
      },
      terminal: {
        background: "#ffffff",
        foreground: "#0b0b0d",
        cursor: "#0b0b0d",
        cursorAccent: "#ffffff",
        selection: "rgba(11, 11, 13, 0.16)",
        ansi: [
          "#3a3a41",
          "#a84848",
          "#2f6b45",
          "#7a6320",
          "#2f5a8a",
          "#6b4a78",
          "#2c6b68",
          "#63636b",
          "#54545c",
          "#c05a5a",
          "#3d8256",
          "#94772c",
          "#3d6ba0",
          "#835a90",
          "#3a8080",
          "#0b0b0d",
        ],
      },
    },
  },
};
