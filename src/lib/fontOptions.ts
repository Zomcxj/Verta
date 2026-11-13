import { BUNDLED_MONO_FAMILY } from "./fonts";

/**
 * Options for the font dropdown in settings.
 *
 * "Auto-detect" is a real option (its value is the empty string), because an empty
 * terminal / icon font already meant auto-detect in the old behavior. The **current
 * value** is also included: the config may have been written on another machine, or
 * the font uninstalled since, and without it the dropdown cannot show the current
 * state (a Select renders blank).
 *
 * The **bundled** families are included whether or not the machine has them: they ship
 * with the application as `@font-face`, so they are the only entries that are guaranteed
 * to work - and one of them, JetBrains Mono, is what every stack silently falls back to.
 * Leaving it out of the list meant a shipped font could not be chosen, and the face that
 * gets drawn when a choice fails could not be seen.
 */

export type FontOption = {
  /** The Select's value: the family name; the empty string means "auto-detect". */
  value: string;
  label: string;
  /** Not installed locally: label it in the UI so it does not look like the font is broken. */
  missing?: boolean;
  /** Shipped with the application, so it works even where it is not installed. */
  bundled?: boolean;
};

/** Families the application itself carries (see `styles/fonts.css`). */
export const BUNDLED_FONT_FAMILIES: readonly string[] = [BUNDLED_MONO_FAMILY];

export function fontOptions(
  installed: string[] | null,
  current: string,
  autoLabel: string,
  bundled: readonly string[] = BUNDLED_FONT_FAMILIES,
): FontOption[] {
  const options: FontOption[] = [{ value: "", label: autoLabel }];
  const seen = new Set<string>([""]);
  const key = (value: string) => value.trim().toLowerCase();
  const installedNames = installed ?? [];
  /** Shipped families count as present: "not installed" must not be said about a face the app carries. */
  const available = new Set([...installedNames, ...bundled].map(key));

  const currentName = current.trim();
  if (currentName && !available.has(key(currentName))) {
    options.push({ value: currentName, label: currentName, missing: true });
    seen.add(key(currentName));
  }

  // Before the machine's own list: these work everywhere, and the one that is not installed is still
  // the face that gets drawn when a chosen font cannot be found.
  for (const raw of bundled) {
    const name = raw.trim();
    if (!name || seen.has(key(name))) continue;
    seen.add(key(name));
    options.push({ value: name, label: name, bundled: true });
  }

  for (const raw of installedNames) {
    const name = raw.trim();
    if (!name || seen.has(key(name))) continue;
    seen.add(key(name));
    options.push({ value: name, label: name });
  }
  return options;
}
