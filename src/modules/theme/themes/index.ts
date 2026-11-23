import { DEFAULT_THEME_ID, type Theme } from "../types";
import { acrylic } from "./acrylic";
import { atomOne } from "./atom-one";
import { caffeine } from "./caffeine";
import { catppuccin } from "./catppuccin";
import { claude } from "./claude";
import { dracula } from "./dracula";
import { everforest } from "./everforest";
import { gruvbox } from "./gruvbox";
import { kanagawa } from "./kanagawa";
import { kanagawaDragon } from "./kanagawa-dragon";
import { nord } from "./nord";
import { rosePine } from "./rose-pine";
import { sage } from "./sage";
import { solarized } from "./solarized";
import { terax } from "./terax";
import { tide } from "./tide";
import { tokyoNight } from "./tokyo-night";
import { vertaDefault } from "./verta-default";
import { xcode } from "./xcode";

const BUILTIN: Theme[] = [
  // The brand theme first: it is what a fresh install starts on, and it is what people
  // are looking for when they open this page. Every other theme is listed by its first letter.
  vertaDefault,
  // Alphabetical from here. `listBuiltinThemes` sorts as well, so a theme dropped in the wrong
  // place is still offered in order; this arrangement is what the array reads like, not the rule.
  atomOne,
  caffeine,
  catppuccin,
  claude,
  dracula,
  everforest,
  gruvbox,
  kanagawa,
  kanagawaDragon,
  nord,
  rosePine,
  sage,
  solarized,
  terax,
  tide,
  tokyoNight,
  xcode,
  // Retired, but kept in `BY_ID` so a settings file that still names it resolves:
  // `listBuiltinThemes` filters it out of the picker below.
  acrylic,
];

const BY_ID = new Map<string, Theme>(BUILTIN.map((t) => [t.id, t]));

/**
 * Themes that still resolve but are no longer offered.
 *
 * `acrylic` is here because it stopped being a theme. What made it what it is - the material the
 * window is drawn with - is the `glass` shape, and a shape is not a palette: any theme can be drawn
 * in it. Keeping the id resolvable means a settings file that still says `themeId: "acrylic"` opens
 * as its own colours with the glass shape suggested, instead of silently falling back.
 */
const RETIRED = new Set(["acrylic"]);

/**
 * The picker's order: the brand theme first, then every other theme by its first letter.
 *
 * The comparison is `localeCompare` on the display name rather than on the id, because the name is
 * what the list shows: `verta-default` would otherwise sort under V, and `atom-one` under A, which
 * is only true by accident of how the files were named. Ties fall back to the id so the order is
 * stable for two themes whose names start with the same letters (`Kanagawa` / `Kanagawa Dragon`).
 */
export function listBuiltinThemes(): Theme[] {
  return BUILTIN.filter((t) => !RETIRED.has(t.id)).sort((a, b) => {
    if (a.id === DEFAULT_THEME_ID) return -1;
    if (b.id === DEFAULT_THEME_ID) return 1;
    return a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en");
  });
}

export function getBuiltinTheme(id: string): Theme | undefined {
  return BY_ID.get(id);
}

export function getDefaultTheme(): Theme {
  return BY_ID.get(DEFAULT_THEME_ID) ?? BUILTIN[0];
}
