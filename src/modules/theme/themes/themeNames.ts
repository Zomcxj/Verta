import type { MessageKey } from "@/modules/i18n";

/**
 * Chinese theme names and descriptions.
 *
 * A theme's own `name` / `description` are English or proper names, and the UI looks
 * the translation up here by id; a theme with no entry (one the user imported
 * themselves) keeps whatever it ships.
 *
 * **Proper names stay untranslated**: Dracula, Nord, Kanagawa, Catppuccin, Solarized,
 * Gruvbox, Everforest, Tokyo Night and Rosé Pine are the color schemes' own names, and
 * a Chinese rendering only makes them harder to recognize; Acrylic / Carbon Fiber are
 * the same (they name a material, not describe one), so the name stays in English and
 * only the description gets translated. Just the descriptive ones (Sage / Tide /
 * Caffeine / Xcode / Claude) have a Chinese form.
 *
 * **A description is one short sentence**: say what it looks like, don't write a
 * narration; where it came from and how it is built (how much blur, whether the panels
 * are opaque) belong in the theme file's own comments.
 */
type Entry = { name?: string; description?: string };

const ZH: Record<string, Entry> = {
  verta: {
    name: "Verta",
    description: "近黑底配纯白强调色。",
  },
  acrylic: {
    name: "Acrylic",
    description: "磨砂玻璃，桌面透过来。",
  },
  "carbon-weave": {
    name: "Carbon Fiber",
    description: "石墨配银青色，碳纤维的配色。",
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

/** A theme's Chinese name; falls back to the theme's own name. */
export function themeName(
  id: string,
  fallback: string,
  language: string,
): string {
  if (language !== "zh") return fallback;
  return ZH[id]?.name ?? fallback;
}

/** A theme's Chinese description; falls back to the theme's own description. */
export function themeDescription(
  id: string,
  fallback: string | undefined,
  language: string,
): string | undefined {
  if (language !== "zh") return fallback;
  return ZH[id]?.description ?? fallback;
}

/**
 * Accessible names for the UI's "edit theme / remove theme" buttons; they follow the
 * interface language.
 *
 * `MessageKey` only narrows the key type here; the text still comes from the caller's `t`.
 */
export const THEME_A11Y = {
  edit: "settings.themes.editTheme",
  remove: "settings.themes.removeTheme",
} as const satisfies Record<string, MessageKey>;
