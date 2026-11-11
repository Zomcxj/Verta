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

  // The material is the shape's, not the theme's: `glass` is the preset that asks for the real
  // desktop blur (Windows: acrylic), and a theme is colours. It turns on by itself, without the
  // settings switch, because choosing that shape *is* the request.
  const glass = shapeMaterial;

  useEffect(() => {
    if (!hydrated) return;
    void applyVibrancy(
      enabled,
      resolvedMode === "dark",
      activeTheme.id,
      glass,
    );
  }, [enabled, hydrated, resolvedMode, activeTheme.id, glass]);

  return null;
}
