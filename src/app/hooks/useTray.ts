import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { useT } from "@/modules/i18n";
import { usePreferencesStore } from "@/modules/settings/preferences";

/**
 * Wires the system tray: its labels follow the interface language, and its menu
 * Quit item asks the page first (the page owns the unsaved-work guard, so the
 * window is never killed behind its back).
 *
 * The close-to-tray preference is mirrored into Rust here because the close
 * handler runs in Rust, where the preferences store is not reachable.
 */
export function useTray(onQuitRequested: () => void): void {
  const t = useT();
  const closeToTray = usePreferencesStore((s) => s.closeToTray);

  useEffect(() => {
    void invoke("tray_set_labels", {
      show: t("tray.show"),
      // The numbers, from the tray: a glance at what has been used should not need the main window
      // in front first.
      usage: t("tray.usage"),
      // The item that exists for the window being out of the way: a shortcut needs the focus, a
      // tray click does not.
      screenshot: t("tray.screenshot"),
      quit: t("tray.quit"),
    }).catch((error) => {
      console.error("[verta] tray setup failed:", error);
    });
  }, [t]);

  useEffect(() => {
    void invoke("tray_set_close_to_tray", { enabled: closeToTray }).catch(
      (error) => {
        console.error("[verta] tray close mode failed:", error);
      },
    );
  }, [closeToTray]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen("verta:quit-requested", () => {
      void onQuitRequested();
    }).then((un) => {
      if (disposed) un();
      else unlisten = un;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [onQuitRequested]);
}
