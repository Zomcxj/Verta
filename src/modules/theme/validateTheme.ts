import type { MessageKey } from "@/modules/i18n";
import type {
  Theme,
  ThemeColors,
  ThemeGlass,
  ThemeSurface,
  ThemeVariant,
  TerminalPalette,
} from "./types";

/** A message key plus its values, not a sentence: the dialog resolves it at render time. */
export type ValidationFailure = {
  key: MessageKey;
  values?: Record<string, string | number>;
};

export type ValidationResult =
  | { ok: true; theme: Theme }
  | { ok: false; error: ValidationFailure };

const COLOR_KEYS: readonly (keyof ThemeColors)[] = [
  "background", "foreground",
  "card", "cardForeground",
  "popover", "popoverForeground",
  "primary", "primaryForeground",
  "secondary", "secondaryForeground",
  "muted", "mutedForeground",
  "accent", "accentForeground",
  "destructive",
  "border", "input", "ring",
  "sidebar", "sidebarForeground",
  "sidebarPrimary", "sidebarPrimaryForeground",
  "sidebarAccent", "sidebarAccentForeground",
  "sidebarBorder", "sidebarRing",
  "radius",
];

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const TERMINAL_FONT_WEIGHTS = new Set([
  "normal",
  "bold",
  "100",
  "200",
  "300",
  "400",
  "500",
  "600",
  "700",
  "800",
  "900",
]);
const TERMINAL_FONT_SIZE_MIN = 8;
const TERMINAL_FONT_SIZE_MAX = 32;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

/**
 * A parsed value and a failure travel in the same return type, so this tells the
 * two apart. No theme value ever carries a `key` property, so the test is exact.
 */
function isFailure(value: unknown): value is ValidationFailure {
  return typeof value === "object" && value !== null && "key" in value;
}

function parseColors(raw: unknown, path: string): ThemeColors | ValidationFailure {
  if (raw === undefined) return {};
  if (!isObj(raw)) return { key: "theme.validate.object", values: { path } };
  const out: ThemeColors = {};
  for (const k of Object.keys(raw)) {
    if (!(COLOR_KEYS as string[]).includes(k)) {
      return {
        key: "theme.validate.unknownColorKey",
        values: { path: `${path}.${k}` },
      };
    }
    const v = raw[k];
    if (!isStr(v) || v.length === 0) {
      return {
        key: "theme.validate.nonEmptyString",
        values: { path: `${path}.${k}` },
      };
    }
    out[k as keyof ThemeColors] = v;
  }
  return out;
}

function parseTerminal(
  raw: unknown,
  path: string,
): TerminalPalette | ValidationFailure {
  if (raw === undefined) return {};
  if (!isObj(raw)) return { key: "theme.validate.object", values: { path } };
  const out: TerminalPalette = {};
  if (raw.background !== undefined) {
    if (!isStr(raw.background)) {
      return {
        key: "theme.validate.string",
        values: { path: `${path}.background` },
      };
    }
    out.background = raw.background;
  }
  if (raw.foreground !== undefined) {
    if (!isStr(raw.foreground)) {
      return {
        key: "theme.validate.string",
        values: { path: `${path}.foreground` },
      };
    }
    out.foreground = raw.foreground;
  }
  if (raw.cursor !== undefined) {
    if (!isStr(raw.cursor)) {
      return {
        key: "theme.validate.string",
        values: { path: `${path}.cursor` },
      };
    }
    out.cursor = raw.cursor;
  }
  if (raw.cursorAccent !== undefined) {
    if (!isStr(raw.cursorAccent)) {
      return {
        key: "theme.validate.string",
        values: { path: `${path}.cursorAccent` },
      };
    }
    out.cursorAccent = raw.cursorAccent;
  }
  if (raw.selection !== undefined) {
    if (!isStr(raw.selection)) {
      return {
        key: "theme.validate.string",
        values: { path: `${path}.selection` },
      };
    }
    out.selection = raw.selection;
  }
  if (raw.fontFamily !== undefined) {
    if (!isStr(raw.fontFamily) || raw.fontFamily.trim().length === 0) {
      return {
        key: "theme.validate.nonEmptyString",
        values: { path: `${path}.fontFamily` },
      };
    }
    out.fontFamily = raw.fontFamily.trim();
  }
  if (raw.fontWeight !== undefined) {
    if (!isStr(raw.fontWeight) || !TERMINAL_FONT_WEIGHTS.has(raw.fontWeight)) {
      return {
        key: "theme.validate.fontWeight",
        values: { path: `${path}.fontWeight` },
      };
    }
    out.fontWeight = raw.fontWeight;
  }
  if (raw.fontSize !== undefined) {
    if (
      typeof raw.fontSize !== "number" ||
      !Number.isInteger(raw.fontSize) ||
      raw.fontSize < TERMINAL_FONT_SIZE_MIN ||
      raw.fontSize > TERMINAL_FONT_SIZE_MAX
    ) {
      return {
        key: "theme.validate.fontSize",
        values: {
          path: `${path}.fontSize`,
          min: TERMINAL_FONT_SIZE_MIN,
          max: TERMINAL_FONT_SIZE_MAX,
        },
      };
    }
    out.fontSize = raw.fontSize;
  }
  if (raw.ansi !== undefined) {
    if (!Array.isArray(raw.ansi) || raw.ansi.length !== 16) {
      return {
        key: "theme.validate.ansiArray",
        values: { path: `${path}.ansi` },
      };
    }
    for (let i = 0; i < 16; i++) {
      if (!isStr(raw.ansi[i])) {
        return {
          key: "theme.validate.string",
          values: { path: `${path}.ansi[${i}]` },
        };
      }
    }
    out.ansi = raw.ansi as unknown as TerminalPalette["ansi"];
  }
  return out;
}

function parseVariant(raw: unknown, path: string): ThemeVariant | ValidationFailure {
  if (!isObj(raw)) return { key: "theme.validate.object", values: { path } };
  const colors = parseColors(raw.colors, `${path}.colors`);
  if (isFailure(colors)) return colors;
  const terminal = parseTerminal(raw.terminal, `${path}.terminal`);
  if (isFailure(terminal)) return terminal;
  const surface = parseSurface(raw.surface, `${path}.surface`);
  if (isFailure(surface)) return surface;
  const glass = parseGlass(raw.glass, `${path}.glass`);
  if (isFailure(glass)) return glass;
  return { colors, terminal, surface, glass };
}

/**
 * The surface layer (gradient / texture). All fields are optional, and a bad one is
 * reported by name rather than rejecting the whole theme.
 *
 * `image` accepts only CSS `background-image` values (gradients, `url(...)`) and no
 * other CSS, because it is written into a style variable, and an unexpected property
 * there would let a theme file restyle anything.
 */
function parseSurface(
  raw: unknown,
  path: string,
): ThemeSurface | undefined | ValidationFailure {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) return { key: "theme.validate.object", values: { path } };
  const out: ThemeSurface = {};
  const KEYS = ["background", "image", "repeat", "size", "blend"] as const;
  for (const key of KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!isStr(value)) {
      return {
        key: "theme.validate.string",
        values: { path: `${path}.${key}` },
      };
    }
    if (key === "repeat") {
      if (value !== "repeat" && value !== "no-repeat") {
        return {
          key: "theme.validate.surfaceRepeat",
          values: { path: `${path}.repeat` },
        };
      }
      out.repeat = value;
    } else {
      out[key] = value;
    }
  }
  if (raw.opacity !== undefined) {
    const opacity = raw.opacity;
    if (typeof opacity !== "number" || !Number.isFinite(opacity)) {
      return {
        key: "theme.validate.number",
        values: { path: `${path}.opacity` },
      };
    }
    out.opacity = Math.min(1, Math.max(0, opacity));
  }
  return out;
}

/**
 * The glass fields: all ratios in 0-1 or pixel counts, and a bad one is reported by
 * name.
 *
 * Custom themes can use them because the glass look comes from making the frame and
 * panes translucent, since colors alone are not enough.
 */
function parseGlass(
  raw: unknown,
  path: string,
): ThemeGlass | undefined | ValidationFailure {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) return { key: "theme.validate.object", values: { path } };
  const out: ThemeGlass = {};
  const RATIOS = ["frame", "pane", "edge"] as const;
  for (const key of RATIOS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return {
        key: "theme.validate.number",
        values: { path: `${path}.${key}` },
      };
    }
    out[key] = Math.min(1, Math.max(0, value));
  }
  if (raw.desktop !== undefined) {
    if (typeof raw.desktop !== "boolean") {
      return {
        key: "theme.validate.boolean",
        values: { path: `${path}.desktop` },
      };
    }
    out.desktop = raw.desktop;
  }
  return out;
}

export function validateTheme(raw: unknown): ValidationResult {
  if (!isObj(raw)) return { ok: false, error: { key: "theme.validate.notObject" } };
  if (!isStr(raw.id) || !ID_RE.test(raw.id)) {
    return { ok: false, error: { key: "theme.validate.id" } };
  }
  if (!isStr(raw.name) || raw.name.trim().length === 0) {
    return { ok: false, error: { key: "theme.validate.name" } };
  }
  if (!isObj(raw.variants)) {
    return {
      ok: false,
      error: { key: "theme.validate.object", values: { path: "variants" } },
    };
  }
  const variants: Theme["variants"] = {};
  if (raw.variants.light !== undefined) {
    const v = parseVariant(raw.variants.light, "variants.light");
    if (isFailure(v)) return { ok: false, error: v };
    variants.light = v;
  }
  if (raw.variants.dark !== undefined) {
    const v = parseVariant(raw.variants.dark, "variants.dark");
    if (isFailure(v)) return { ok: false, error: v };
    variants.dark = v;
  }
  if (!variants.light && !variants.dark) {
    return { ok: false, error: { key: "theme.validate.variantsNeeded" } };
  }
  const theme: Theme = {
    id: raw.id,
    name: raw.name.trim(),
    variants,
  };
  if (isStr(raw.author)) theme.author = raw.author;
  if (isStr(raw.description)) theme.description = raw.description;
  if (isObj(raw.editorTheme)) {
    const et: Theme["editorTheme"] = {};
    if (isStr(raw.editorTheme.light)) et.light = raw.editorTheme.light;
    if (isStr(raw.editorTheme.dark)) et.dark = raw.editorTheme.dark;
    if (et.light || et.dark) theme.editorTheme = et;
  }
  return { ok: true, theme };
}