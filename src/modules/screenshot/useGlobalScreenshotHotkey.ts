import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { toast } from "sonner";
import { useT } from "@/modules/i18n";
import { SHORTCUTS } from "@/modules/shortcuts";
import { usePreferencesStore } from "@/modules/settings/preferences";

/** The chord the catalogue ships for a capture, for a user who has never rebound it. */
const DEFAULT_BINDING = SHORTCUTS.find(
  (shortcut) => shortcut.id === "screenshot.capture",
)?.defaultBindings?.[0];

/**
 * Holds the screenshot's chord outside the window.
 *
 * `useGlobalShortcuts` is a *window* listener: Windows delivers those keys only to a focused window,
 * so a capture of the screen behind a minimised, tray-hidden or unfocused app could not be asked for
 * at all. The grab never needed the focus - it reads the screen - so what is registered here is the
 * same chord the shell already listens for, handed to the operating system, which delivers it
 * wherever the keyboard is.
 *
 * Kept in step with the preference rather than set once: rebinding `screenshot.capture` has to move
 * the global chord too, and clearing it has to release it - a global hotkey that outlives its
 * binding is a key the whole machine loses.
 */
export function useGlobalScreenshotHotkey(): void {
  const t = useT();
  const userShortcuts = usePreferencesStore((state) => state.shortcuts);

  useEffect(() => {
    const binding = userShortcuts["screenshot.capture"]?.[0] ?? DEFAULT_BINDING;
    void invoke("screenshot_set_global_hotkey", {
      // The backend refuses a chord with no modifier, because a global hotkey is taken from every
      // application on the machine.
      chord: binding
        ? {
            alt: Boolean(binding.alt),
            ctrl: Boolean(binding.ctrl),
            shift: Boolean(binding.shift),
            meta: Boolean(binding.meta),
            key: binding.key,
          }
        : null,
    }).catch((error) => {
      // Another application already owning the chord is the usual reason, and the in-window
      // shortcut still works, so this is reported rather than thrown away.
      toast.error(t("screenshot.hotkeyFailed", { error: String(error) }));
    });
  }, [userShortcuts, t]);
}
