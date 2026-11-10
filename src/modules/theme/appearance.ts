import type { Theme, ThemeAppearance, ThemeMode } from "./types";

/**
 * The appearance a theme asks for, and the appearance actually in force.
 *
 * Three things used to be global switches that a theme could not have an opinion about: the desktop
 * material, how opaque the user's background image is, and how blurred it is. A theme knows what it
 * wants - `acrylic` is a theme whose entire point is the material - so a variant can declare
 * defaults for them, and the settings page shows what the theme says until the user disagrees.
 *
 * The rule is the one this store already uses everywhere (`store.ts`, next to the theme-id
 * fallback): **a value the user stored wins; with nothing stored, the theme's default applies; with
 * neither, today's default**. What makes that work without a migration is that "nothing stored" is
 * knowable: the loader has the whole settings map in hand and can ask whether the key is there,
 * which is not the same question as whether the value differs from the default (a user who switched
 * the material off is not a user who never touched it).
 *
 * Pure: no document, no storage. The caller reads the stored values and writes the answer.
 */

/** What the desktop material can be. `none` is "no material", which is what a missing switch means. */
export type Backdrop = "none" | "native" | "acrylic";

export type StoredAppearance = {
  /**
   * The material, when the user has said something about it.
   *
   * Today that is the `windowVibrancy` boolean - on means `native`, off means `none` - and the caller
   * only fills this in when the key exists in storage, so a fresh install follows its theme.
   */
  backdrop?: Backdrop;
  backgroundOpacity?: number;
  backgroundBlur?: number;
};

/** Where one field's value came from, which is what lets the settings page say "following the theme". */
export type AppearanceSource = "user" | "theme" | "default";

export type ResolvedAppearance = {
  backdrop: Backdrop;
  backgroundOpacity: number;
  backgroundBlur: number;
  source: {
    backdrop: AppearanceSource;
    backgroundOpacity: AppearanceSource;
    backgroundBlur: AppearanceSource;
  };
};

/** Today's defaults, unchanged, and what a theme that says nothing inherits. */
export const DEFAULT_APPEARANCE = {
  backdrop: "none" as Backdrop,
  backgroundOpacity: 0.5,
  backgroundBlur: 0,
} as const;

/** The blur ceiling the settings slider offers; anything above it is a hand-edited file. */
const BLUR_MAX = 64;

/**
 * The variant a mode means.
 *
 * The same fallback `applyTheme` uses - the asked-for mode, else dark, else light - because a theme
 * with one variant answers both modes with it, and the appearance has to be read off the same variant
 * the colours came from.
 */
function variantOf(
  theme: Theme | null | undefined,
  mode: ThemeMode,
): { appearance?: ThemeAppearance } | undefined {
  if (!theme) return undefined;
  return theme.variants[mode] ?? theme.variants.dark ?? theme.variants.light;
}

/** A number in a range, or nothing: a theme file is editable, so a string or a NaN is refused. */
function numberIn(
  value: unknown,
  min: number,
  max: number,
  round = false,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const clamped = Math.min(max, Math.max(min, value));
  return round ? Math.round(clamped) : clamped;
}

function backdropOf(value: unknown): Backdrop | undefined {
  return value === "none" || value === "native" || value === "acrylic"
    ? value
    : undefined;
}

/**
 * What the appearance is, given a theme, a mode and whatever the user has stored.
 *
 * Each field is decided on its own: a user who set only the blur keeps the theme's material and
 * opacity, and the `source` says so field by field.
 */
export function resolveAppearance(
  theme: Theme | null | undefined,
  mode: ThemeMode,
  stored: StoredAppearance = {},
): ResolvedAppearance {
  const declared = variantOf(theme, mode)?.appearance;

  const backdrop = backdropOf(stored.backdrop);
  const themeBackdrop = backdropOf(declared?.backdrop);
  const opacity = numberIn(stored.backgroundOpacity, 0, 1);
  const themeOpacity = numberIn(declared?.backgroundOpacity, 0, 1);
  const blur = numberIn(stored.backgroundBlur, 0, BLUR_MAX, true);
  const themeBlur = numberIn(declared?.backgroundBlur, 0, BLUR_MAX, true);

  return {
    backdrop: backdrop ?? themeBackdrop ?? DEFAULT_APPEARANCE.backdrop,
    backgroundOpacity:
      opacity ?? themeOpacity ?? DEFAULT_APPEARANCE.backgroundOpacity,
    backgroundBlur: blur ?? themeBlur ?? DEFAULT_APPEARANCE.backgroundBlur,
    source: {
      backdrop: backdrop ? "user" : themeBackdrop ? "theme" : "default",
      backgroundOpacity:
        opacity !== undefined
          ? "user"
          : themeOpacity !== undefined
            ? "theme"
            : "default",
      backgroundBlur:
        blur !== undefined ? "user" : themeBlur !== undefined ? "theme" : "default",
    },
  };
}
