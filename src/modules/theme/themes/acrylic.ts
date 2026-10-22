import type { Theme } from "../types";

/**
 * 亚克力（Windows 11 的 Desktop Acrylic）。
 *
 * 不是「自己在界面里画一层半透明」—— 那种做法底下永远只有应用自己的颜色，
 * 看起来只是一块灰板。真正的亚克力由 DWM 画在窗口背后：
 * `DWMWA_SYSTEMBACKDROP_TYPE = DWMSBT_TRANSIENTWINDOW`（微软文档原话：
 * "For Windows 11, this corresponds to Desktop Acrylic, also known as Background
 * Acrylic, in its brightest variant"），桌面被真实地模糊、带噪声、微微提亮，
 * 窗口里所有透明的地方都透出它。这个主题的 `glass.desktop` 一开，
 * `WindowVibrancyBridge` 就会去切那块原生材质。
 *
 * 用色遵循微软 Acrylic 的配方：一层薄薄的**色调** + 顶部一道高光。色调压得低，
 * 因为桌面本身已经提供了绝大部分质感；色调一重，亚克力就退化成普通半透明面板。
 *
 * **这个主题刻意不带 `surface`**：表面层会在整窗铺一层底色，正好盖住 DWM 画在窗口
 * 背后的桌面模糊 —— 那就白做原生材质了。质感只由材质 + 这里的色调提供。
 *
 * 也刻意不写任何 CSS 模糊：`filter` 会把界面自己糊掉，而 CSS 里那类「采样背后」的滤镜
 * 只能看到同一文档内的内容，**永远够不到桌面**。见 `styles/globals.css` 里那段注释。
 */
export const acrylic: Theme = {
  id: "acrylic",
  name: "Acrylic",
  description:
    "Desktop Acrylic: the desktop really shows through the window — blurred, noisy, slightly lifted.",
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
        // 色调薄：桌面占大头。深色下略厚一点，免得浅色桌面把深色主题冲淡。
        frame: 0.24,
        pane: 0.28,
        edge: 0.3,
        sheen: 0.12,
        desktop: true,
      },
      terminal: {
        // alpha 0 = 终端自己那层底色不外画：终端区域与外面的面板同透，
        // 桌面模糊在终端里也看得见（TUI 自己设的色块仍然是不透明的，见着色器）。
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
        // 浅色亚克力：面板是一层很淡的白，底下的桌面模糊托着它。
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
        // 浅色可以让桌面透得更多：白色面板就算薄，字也压得住。
        frame: 0.3,
        pane: 0.34,
        edge: 0.6,
        sheen: 0.2,
        desktop: true,
      },
      terminal: {
        // 同上：浅色也让这一层全透。
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
