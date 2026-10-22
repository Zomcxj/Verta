import type {
  Theme,
  ThemeColors,
  ThemeMode,
  ThemeGlass,
  ThemeSurface,
  TerminalPalette,
} from "./types";

const COLOR_VAR: Record<keyof ThemeColors, string> = {
  background: "--background",
  foreground: "--foreground",
  card: "--card",
  cardForeground: "--card-foreground",
  popover: "--popover",
  popoverForeground: "--popover-foreground",
  primary: "--primary",
  primaryForeground: "--primary-foreground",
  secondary: "--secondary",
  secondaryForeground: "--secondary-foreground",
  muted: "--muted",
  mutedForeground: "--muted-foreground",
  accent: "--accent",
  accentForeground: "--accent-foreground",
  destructive: "--destructive",
  border: "--border",
  input: "--input",
  ring: "--ring",
  sidebar: "--sidebar",
  sidebarForeground: "--sidebar-foreground",
  sidebarPrimary: "--sidebar-primary",
  sidebarPrimaryForeground: "--sidebar-primary-foreground",
  sidebarAccent: "--sidebar-accent",
  sidebarAccentForeground: "--sidebar-accent-foreground",
  sidebarBorder: "--sidebar-border",
  sidebarRing: "--sidebar-ring",
  radius: "--radius",
};

const ANSI_VARS: readonly string[] = [
  "--terminal-ansi-black",
  "--terminal-ansi-red",
  "--terminal-ansi-green",
  "--terminal-ansi-yellow",
  "--terminal-ansi-blue",
  "--terminal-ansi-magenta",
  "--terminal-ansi-cyan",
  "--terminal-ansi-white",
  "--terminal-ansi-bright-black",
  "--terminal-ansi-bright-red",
  "--terminal-ansi-bright-green",
  "--terminal-ansi-bright-yellow",
  "--terminal-ansi-bright-blue",
  "--terminal-ansi-bright-magenta",
  "--terminal-ansi-bright-cyan",
  "--terminal-ansi-bright-white",
];

const ALL_VARS: readonly string[] = [
  ...Object.values(COLOR_VAR),
  "--terminal-background",
  "--terminal-foreground",
  "--terminal-cursor",
  "--terminal-cursor-accent",
  "--terminal-selection",
  ...ANSI_VARS,
];

let lastApplied: string | null = null;

/** 主题自己带的表面层变量（离开一个带纹理的主题时要一起撤掉）。 */
const SURFACE_VARS: readonly string[] = [
  "--theme-surface-background",
  "--theme-surface-image",
  "--theme-surface-repeat",
  "--theme-surface-size",
  "--theme-surface-opacity",
  "--theme-surface-blend",
];

/** 玻璃那套：窗口框架与面板的透明度、边缘亮度。 */
const GLASS_VARS: readonly string[] = [
  "--theme-frame-opacity",
  "--theme-pane-opacity",
  "--theme-glass-edge",
  "--theme-glass-sheen",
];

export function applyTheme(theme: Theme, mode: ThemeMode): void {
  const root = document.documentElement;
  const variant = theme.variants[mode] ?? theme.variants.dark ?? theme.variants.light;
  if (!variant) {
    clearTheme();
    return;
  }
  const colors = variant.colors;
  const terminal = variant.terminal;
  for (const v of ALL_VARS) root.style.removeProperty(v);
  if (colors) writeColors(root, colors);
  if (terminal) writeTerminal(root, terminal);
  writeSurface(root, variant.surface);
  writeGlass(root, variant.glass);
  lastApplied = theme.id;
}

export function clearTheme(): void {
  if (lastApplied === null) return;
  const root = document.documentElement;
  for (const v of ALL_VARS) root.style.removeProperty(v);
  writeSurface(root, undefined);
  writeGlass(root, undefined);
  lastApplied = null;
}

/**
 * 表面层只写 CSS 变量，真正铺出来的是 `SurfaceLayer` 那个 `[data-theme-surface]`。
 *
 * 不直接往 `body` 上刷背景：开着背景图时那层是全屏覆盖的，直接给 body 上色会两边打架，
 * 而且设置窗口 / 截图窗口也会跟着变。放在专门的元素上，谁需要谁读变量。
 */
function writeSurface(root: HTMLElement, surface: ThemeSurface | undefined): void {
  for (const v of SURFACE_VARS) root.style.removeProperty(v);
  if (!surface) {
    root.removeAttribute("data-theme-surface");
    return;
  }
  const set = (name: string, value: string | number | undefined) => {
    if (value === undefined || value === "") return;
    root.style.setProperty(name, String(value));
  };
  set("--theme-surface-background", surface.background);
  set("--theme-surface-image", surface.image);
  set("--theme-surface-repeat", surface.repeat);
  set("--theme-surface-size", surface.size);
  set("--theme-surface-opacity", surface.opacity);
  set("--theme-surface-blend", surface.blend);
  const drawn = surface.background || surface.image;
  if (drawn) root.setAttribute("data-theme-surface", "on");
  else root.removeAttribute("data-theme-surface");
}

/**
 * 玻璃：只有真给了透明度才打开（`data-theme-glass="on"`）。
 *
 * CSS 那边靠这个属性决定要不要把 `--frame` 与 `.verta-pane` 换成半透明的写法；
 * 不给的话这两层保持原来的不透明，一点开销都不多。
 */
function writeGlass(root: HTMLElement, glass: ThemeGlass | undefined): void {
  for (const v of GLASS_VARS) root.style.removeProperty(v);
  if (!glass) {
    root.removeAttribute("data-theme-glass");
    return;
  }
  const set = (name: string, value: number | undefined) => {
    if (value === undefined) return;
    // 下限放到 0.02：苹果那种玻璃面板本身就几乎全透，文字靠模糊与高光托着。
    root.style.setProperty(name, String(Math.min(1, Math.max(0.02, value))));
  };
  set("--theme-frame-opacity", glass.frame);
  set("--theme-pane-opacity", glass.pane);
  // 这里刻意不写任何 `filter`：模糊是原生材质（Windows 的 DWM 亚克力 / macOS 的
  // NSVisualEffectView）画在窗口**背后**的，CSS 够不着；而在 #root 上写 blur 只会把
  // 界面自己糊掉 —— 第一版就是这么错的，看起来像一团糊而不是玻璃。
  // 饱和同理：材质自带，再叠一层会连界面颜色一起改。
  if (glass.sheen !== undefined) {
    root.style.setProperty(
      "--theme-glass-sheen",
      String(Math.min(1, Math.max(0, glass.sheen))),
    );
  }
  if (glass.edge !== undefined) {
    root.style.setProperty(
      "--theme-glass-edge",
      String(Math.min(1, Math.max(0, glass.edge))),
    );
  }
  root.setAttribute("data-theme-glass", "on");
}

function writeColors(root: HTMLElement, c: ThemeColors): void {
  for (const k of Object.keys(c) as (keyof ThemeColors)[]) {
    const v = c[k];
    if (v) root.style.setProperty(COLOR_VAR[k], v);
  }
}

function writeTerminal(root: HTMLElement, t: TerminalPalette): void {
  if (t.background) root.style.setProperty("--terminal-background", t.background);
  if (t.foreground) root.style.setProperty("--terminal-foreground", t.foreground);
  if (t.cursor) root.style.setProperty("--terminal-cursor", t.cursor);
  if (t.cursorAccent) root.style.setProperty("--terminal-cursor-accent", t.cursorAccent);
  if (t.selection) root.style.setProperty("--terminal-selection", t.selection);
  if (t.ansi) {
    for (let i = 0; i < ANSI_VARS.length && i < t.ansi.length; i++) {
      root.style.setProperty(ANSI_VARS[i], t.ansi[i]);
    }
  }
}
