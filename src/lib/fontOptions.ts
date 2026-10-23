/**
 * Options for the font dropdown in settings.
 *
 * "Auto-detect" is a real option (its value is the empty string), because an empty
 * terminal / icon font already meant auto-detect in the old behavior. The **current
 * value** is also included: the config may have been written on another machine, or
 * the font uninstalled since, and without it the dropdown cannot show the current
 * state (a Select renders blank).
 */

export type FontOption = {
  /** The Select's value: the family name; the empty string means "auto-detect". */
  value: string;
  label: string;
  /** Not installed locally: label it in the UI so it does not look like the font is broken. */
  missing?: boolean;
};

export function fontOptions(
  installed: string[] | null,
  current: string,
  autoLabel: string,
): FontOption[] {
  const options: FontOption[] = [{ value: "", label: autoLabel }];
  const seen = new Set<string>([""]);
  const key = (value: string) => value.trim().toLowerCase();

  const currentName = current.trim();
  if (currentName && !(installed ?? []).some((name) => key(name) === key(currentName))) {
    options.push({ value: currentName, label: currentName, missing: true });
    seen.add(key(currentName));
  }

  for (const raw of installed ?? []) {
    const name = raw.trim();
    if (!name || seen.has(key(name))) continue;
    seen.add(key(name));
    options.push({ value: name, label: name });
  }
  return options;
}
