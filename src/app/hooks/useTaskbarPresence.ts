import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";

/**
 * Keeps the main window in the taskbar, or out of it, following the preference.
 *
 * The button itself is the OS's call (a window is only listed when the shell
 * considers it a main window), so this has to be re-applied whenever the
 * preference changes rather than being a page-level style.
 */
export function useTaskbarPresence(): void {
  const alwaysVisible = usePreferencesStore((s) => s.taskbarAlwaysVisible);

  useEffect(() => {
    void invoke("window_set_taskbar_visible", { visible: alwaysVisible }).catch(
      (error) => {
        console.error("[verta] taskbar presence failed:", error);
      },
    );
  }, [alwaysVisible]);
}
