import type { MessageKey } from "@/modules/i18n";

/**
 * 主题名与说明的中文。
 *
 * 主题自带的 `name` / `description` 是英文/专名，界面按 id 到这里取译文；
 * 没有条目的（用户自己导入的主题）就照原样显示。
 *
 * **专有名不翻**：Dracula、Nord、Kanagawa、Catppuccin、Solarized、Gruvbox、
 * Everforest、Tokyo Night、Rosé Pine 都是配色方案自己的名字，翻成中文反而认不出。
 * 只有描述性的那几个（Sage / Tide / Caffeine / Xcode / Claude）才有中文说法。
 */
type Entry = { name?: string; description?: string };

const ZH: Record<string, Entry> = {
  verta: {
    name: "Verta",
    description: "照应用图标来的黑白：近黑的底，纯白的强调色。",
  },
  acrylic: {
    name: "亚克力",
    description: "照 Windows 11 的亚克力：桌面透进来、模糊、微微提亮。",
  },
  "carbon-weave": {
    name: "碳纤维",
    description: "石墨底上的细蜂窝网格，面板是实心的碳板。",
  },
  "verta-default": {
    name: "Terax",
    description: "干净的中性灰，终端用全套颜色。",
  },
  xcode: {
    name: "Xcode",
    description: "苹果系统配色，以系统蓝作强调色。",
  },
  claude: {
    name: "Claude",
    description: "纸面底色配暖陶土色。",
  },
  kanagawa: { description: "葛饰北斋的深蓝灰调，冷而沉。" },
  "kanagawa-dragon": { description: "同色系的更深一档，夜里用。" },
  "tokyo-night": { description: "东京夜色：深蓝紫配霓虹。" },
  catppuccin: { description: "奶油感的柔和配色。" },
  "rose-pine": { description: "玫瑰金的低饱和配色。" },
  everforest: { description: "森林绿，护眼。" },
  nord: { description: "北欧的冷蓝灰。" },
  gruvbox: { description: "复古暖土色。" },
  dracula: { description: "紫黑底配荧光色。" },
  solarized: { description: "低对比的双色系经典。" },
  tide: { description: "深青灰底配暗湖绿。" },
  sage: { description: "柔和的林绿，安静。" },
  caffeine: { description: "咖啡的暖色 —— 奶油与浓缩。" },
};

/** 主题的中文名；没有译文就用它自己的名字。 */
export function themeName(
  id: string,
  fallback: string,
  language: string,
): string {
  if (language !== "zh") return fallback;
  return ZH[id]?.name ?? fallback;
}

/** 主题的中文说明；没有译文就用它自己的说明。 */
export function themeDescription(
  id: string,
  fallback: string | undefined,
  language: string,
): string | undefined {
  if (language !== "zh") return fallback;
  return ZH[id]?.description ?? fallback;
}

/**
 * 界面上「改主题 / 删主题」按钮的无障碍名，跟着界面语言走。
 *
 * `MessageKey` 在这里只用来收窄键名，取文本仍交给调用方的 `t`。
 */
export const THEME_A11Y = {
  edit: "settings.themes.editTheme",
  remove: "settings.themes.removeTheme",
} as const satisfies Record<string, MessageKey>;
