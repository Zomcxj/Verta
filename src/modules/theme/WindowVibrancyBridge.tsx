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
  const { resolvedMode, activeTheme } = useTheme();

  // A glass theme asks for the real desktop blur (Windows: acrylic). That is a
  // property of the theme, not of the settings switch, so it turns on by itself.
  const glass = Boolean(
    (
      activeTheme.variants[resolvedMode] ??
      activeTheme.variants.dark ??
      activeTheme.variants.light
    )?.glass?.desktop,
  );

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
