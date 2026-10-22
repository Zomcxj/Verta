export type ThemeMode = "light" | "dark";

export type ThemeColors = Partial<{
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  border: string;
  input: string;
  ring: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarPrimary: string;
  sidebarPrimaryForeground: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  sidebarBorder: string;
  sidebarRing: string;
  radius: string;
}>;

export type TerminalPalette = Partial<{
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selection: string;
  fontFamily: string;
  fontWeight: string;
  fontSize: number;
  ansi: readonly [
    string, string, string, string, string, string, string, string,
    string, string, string, string, string, string, string, string,
  ];
}>;

/**
 * 界面上那层「质感」：铺在所有内容底下的一层 CSS 背景。
 *
 * 只做纯 CSS（渐变、极淡的 SVG 纹理），**刻意不做毛玻璃**那种模糊 —— 模糊要给整个窗口
 * 一块额外合成层，窗口拖动和缩放时代价很大，而且会跟背景图那套合成预算打架。
 */
export type ThemeSurface = {
  /** 整层背景色；不写就透明（露出主题自身的背景色）。 */
  background?: string;
  /** 叠在最上面的那层 `background-image`（渐变 / data-URI SVG）。 */
  image?: string;
  /** 这层图怎么重复。渐变一般 `no-repeat`，纹理要 `repeat`。 */
  repeat?: "no-repeat" | "repeat";
  /** 图的大小（`background-size`）。 */
  size?: string;
  /** 不透明度，0–1。 */
  opacity?: number;
  /**
   * 跟主题的底色混合：`soft-light` / `overlay` 之类的 `mix-blend-mode`。
   * 用来让纹理跟着深浅两套配色走，而不是写死一个颜色。
   */
  blend?: string;
};

/**
 * 玻璃：让窗口框架与面板**真的半透明**，露出底下那层表面。
 *
 * 默认 `frame` / `pane` 两层都是不透明的（`--frame` 与 `.verta-pane` 的背景），
 * 所以只给 `surface` 加纹理是看不见的 —— 纹理全被它们盖住。要玻璃感就得让这两层
 * 透出来，同时把边框提亮一点（玻璃的边缘），并给面板一点背景模糊。
 *
 * 模糊**不在这里控制**：真正的模糊是原生材质画在窗口背后的（Windows 的 DWM 亚克力、
 * macOS 的 NSVisualEffectView），CSS 够不着；能调的只有色调与高光，见下面各项。
 */
export type ThemeGlass = {
  /** 面板的**不透明度**，0–1；越小越透明。0.15 基本就是纯玻璃了。 */
  pane?: number;
  /** 框架层（顶栏、状态栏、面板之间的留白）的不透明度，0–1。 */
  frame?: number;
  /** 玻璃边缘的亮度：顶部高光与边框的强度，0–1。 */
  edge?: number;
  /** 面板顶部那道高光渐变的不透明度，0–1。苹果玻璃的「上亮下暗」全靠它。 */
  sheen?: number;
  /**
   * 要不要连**桌面**一起透出来（Windows 的亚克力 / macOS 的 vibrancy）。
   *
   * 只给窗口内部垫一层渐变，永远只是「自己跟自己透」；真正的液态玻璃底下是桌面。
   * 打开它以后，这个主题会自己把原生窗口背景切成亚克力，不用用户再去设置里开关一次。
   */
  desktop?: boolean;
};

export type ThemeVariant = {
  colors?: ThemeColors;
  terminal?: TerminalPalette;
  surface?: ThemeSurface;
  glass?: ThemeGlass;
};

export type Theme = {
  id: string;
  name: string;
  author?: string;
  description?: string;
  variants: {
    light?: ThemeVariant;
    dark?: ThemeVariant;
  };
  editorTheme?: {
    light?: string;
    dark?: string;
  };
};

export const DEFAULT_THEME_ID = "verta-default";
