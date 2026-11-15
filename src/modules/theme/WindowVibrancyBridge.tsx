import { usePreferencesStore } from "@/modules/settings/preferences";
import { useEffect } from "react";
import { useTheme } from "./ThemeProvider";
import { applyVibrancy } from "./vibrancy";

/**
 * Every window that paints the theme has to render this: `window_set_backdrop`
 * targets its caller, so the main window switching to acrylic does not touch the
 * settings window (a separate window with its own webview).
 */
export function WindowVibrancyBridge() {
  const enabled = usePreferencesStore((s) => s.windowVibrancy);
  const hydrated = usePreferencesStore((s) => s.hydrated);
  const { resolvedMode, activeTheme, shapeMaterial } = useTheme();

  // The material is the shape's, not the theme's: `acrylic` and `glass` are the presets that ask for
  // a see-through window, and a theme is colours. It turns on by itself, without the settings
  // switch, because choosing either shape *is* the request. Which of the two it is travels through:
  // one is drawn by the system, the other is a pane with nothing behind it.
  const material = shapeMaterial;

  useEffect(() => {
    if (!hydrated) return;
    void applyVibrancy(
      enabled,
      resolvedMode === "dark",
      activeTheme.id,
      material,
    );
  }, [enabled, hydrated, resolvedMode, activeTheme.id, material]);

  return null;
}
