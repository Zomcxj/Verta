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

export type ThemeVariant = {
  colors?: ThemeColors;
  terminal?: TerminalPalette;
  surface?: ThemeSurface;
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
