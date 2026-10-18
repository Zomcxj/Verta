import { usePreferencesStore } from "@/modules/settings/preferences";
import { useCallback } from "react";
import { type Language, resolveLanguage } from "./language";
import { type MessageKey, translate } from "./messages";

export type { MessageKey } from "./messages";
export { MESSAGES, translate } from "./messages";

/** The locale the webview reports, which is the OS locale on a desktop build. */
function systemLocale(): string | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.language;
}

/** The language the interface should be in right now. */
export function useLanguage(): Language {
  const pref = usePreferencesStore((s) => s.language);
  // Reading the locale is cheap and stable, so it is resolved on each render
  // rather than cached: a language switch must not need a reload.
  return resolveLanguage(pref ?? "system", systemLocale());
}

/**
 * Message lookup bound to the current language.
 *
 * Returns a plain function, so a component calls `t("launcher.manage")` and
 * re-renders when the language changes because the store subscription is here.
 */
export function useT(): (
  key: MessageKey,
  values?: Record<string, string | number>,
) => string {
  const language = useLanguage();
  return useCallback(
    (key: MessageKey, values?: Record<string, string | number>) =>
      translate(language, key, values),
    [language],
  );
}
