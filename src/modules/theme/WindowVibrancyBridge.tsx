import { usePreferencesStore } from "@/modules/settings/preferences";
import { useEffect } from "react";
import { useTheme } from "./ThemeProvider";
import { applyVibrancy } from "./vibrancy";

/** Main window only: `window_set_backdrop` targets its caller. */
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
