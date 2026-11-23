import { DEFAULT_THEME_ID, type Theme } from "../types";
import { caffeine } from "./caffeine";
import { catppuccin } from "./catppuccin";
import { claude } from "./claude";
import { dracula } from "./dracula";
import { everforest } from "./everforest";
import { gruvbox } from "./gruvbox";
import { kanagawa } from "./kanagawa";
import { kanagawaDragon } from "./kanagawa-dragon";
import { acrylic } from "./acrylic";
import { nord } from "./nord";
import { carbonWeave } from "./pattern-base";
import { rosePine } from "./rose-pine";
import { sage } from "./sage";
import { solarized } from "./solarized";
import { vertaDefault } from "./verta-default";
import { tide } from "./tide";
import { tokyoNight } from "./tokyo-night";
import { xcode } from "./xcode";

const BUILTIN: Theme[] = [
  // The brand theme first: it is what a fresh install starts on, and it is what people
  // are looking for when they open this page.
  vertaDefault,
  carbonWeave,
  xcode,
  claude,
  kanagawa,
  kanagawaDragon,
  tokyoNight,
  catppuccin,
  rosePine,
  everforest,
  nord,
  gruvbox,
  dracula,
  solarized,
  tide,
  sage,
  caffeine,
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

export function listBuiltinThemes(): Theme[] {
  return BUILTIN.filter((t) => !RETIRED.has(t.id));
}

export function getBuiltinTheme(id: string): Theme | undefined {
  return BY_ID.get(id);
}

export function getDefaultTheme(): Theme {
  return BY_ID.get(DEFAULT_THEME_ID) ?? BUILTIN[0];
}
