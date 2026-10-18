import { usePreferencesStore } from "@/modules/settings/preferences";
import { resolveLanguage } from "./language";
import { translate } from "./messages";

/**
 * The interface language right now, for code that runs outside React.
 *
 * The stored preference wins, and `system` falls back to the OS locale, which
 * is the same rule the hooks apply. Reading it here rather than in a component
 * lets plain functions produce text that matches what is on screen.
 */
function currentLanguage() {
  const pref = usePreferencesStore.getState().language ?? "system";
  const locale =
    typeof navigator === "undefined" ? undefined : navigator.language;
  return resolveLanguage(pref, locale);
}

/**
 * The name given to the workspace that exists before the user makes one.
 *
 * A workspace name is user data: it is stored, shown, and can be renamed. So
 * this returns resolved text, not a message key. It follows the language the
 * user chose, so a fresh workspace is not born in the wrong language.
 */
export function defaultSpaceName(): string {
  return translate(currentLanguage(), "spaces.defaultName");
}

/**
 * Display name for a workspace.
 *
 * A workspace the user renamed keeps exactly that name: it is their text, not a
 * label. Only the untouched default is translated, so an install that predates
 * the translations reads correctly without rewriting anything on disk.
 */
export function spaceDisplayName(name: string): string {
  const isUntouchedDefault =
    name === translate("zh", "spaces.defaultName") ||
    name === translate("en", "spaces.defaultName");
  return isUntouchedDefault
    ? translate(currentLanguage(), "spaces.defaultName")
    : name;
}
