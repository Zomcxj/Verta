/**
 * Interface language.
 *
 * Two languages only, by request. `system` is what a fresh install uses: it
 * follows the OS locale, which is what a Windows user in Chinese expects and
 * what an English user never notices.
 */
export type LanguagePref = "system" | "zh" | "en";

/** The languages that actually have a translation table. */
export type Language = "zh" | "en";

/**
 * Resolves a stored preference to the table to use.
 *
 * Anything starting with `zh` is Chinese and everything else is English, so a
 * user whose locale is `zh-Hant-TW` still gets the Chinese table rather than
 * falling through to English.
 */
export function resolveLanguage(
  pref: LanguagePref,
  systemLocale: string | undefined,
): Language {
  if (pref === "zh" || pref === "en") return pref;
  return systemLocale?.toLowerCase().startsWith("zh") ? "zh" : "en";
}
