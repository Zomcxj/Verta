import "../styles/globals.css";

import { native } from "@/lib/native";
import { ScreenshotOverlay } from "@/modules/screenshot/ScreenshotOverlay";
import { loadPreferences, onPreferencesChange } from "@/modules/settings/store";
import { applyTheme, clearTheme } from "@/modules/theme/applyTheme";
import { getBuiltinTheme, getDefaultTheme } from "@/modules/theme/themes";
import { DEFAULT_THEME_ID, type ThemeMode } from "@/modules/theme/types";
import ReactDOM from "react-dom/client";

/**
 * Put the current theme's CSS variables on this window too — the selection border,
 * handles, and buttons all use theme colors (`--primary` and friends).
 *
 * No ThemeProvider here: it renders the theme's background layer, which would cover
 * the frozen frame we paint. This only does its color-related job, and since the
 * `verta-default` id's colors already live in globals.css, its overrides have to be
 * cleared (via `clearTheme`, same as ThemeProvider).
 */
async function applyActiveTheme(): Promise<void> {
  const prefs = await loadPreferences();
  const mode: ThemeMode =
    prefs.theme === "dark" || prefs.theme === "light"
      ? prefs.theme
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  // Same as the boot scripts in index.html / settings.html: `--primary` and friends
  // live on :root for light and under .dark for dark, so without that class on the
  // root the theme colors resolve to nothing (outlines fade to gray-white).
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(mode);
  const theme = getBuiltinTheme(prefs.themeId) ?? getDefaultTheme();
  if (theme.id === DEFAULT_THEME_ID) clearTheme();
  else applyTheme(theme, mode);
}

void applyActiveTheme();
// The capture window is kept alive, so a theme change in settings (or a system
// light/dark switch) must be picked up while it lives.
void onPreferencesChange(() => {
  void applyActiveTheme();
});
window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", () => {
    void applyActiveTheme();
  });

// This window is transparent: pixels not dimmed by the gray layer must show the
// screen underneath. globals.css gives body the theme's base color, so override it
// here for this window's nature (inline styles win).
document.documentElement.style.background = "transparent";
document.body.style.background = "transparent";

// Fallback: this window covers the whole screen, so if its own script dies the window
// has to fold itself up — otherwise an unclickable gray layer sits in front of the
// user and only the task manager can clear it. Only script errors count (resource
// load failures do not).
const bailOut = (error: unknown) => {
  void native.screenshotFailed(String(error));
};
window.addEventListener("error", (event) => {
  if (event.error) bailOut(event.error);
});
window.addEventListener("unhandledrejection", (event) => {
  bailOut(event.reason);
});

ReactDOM.createRoot(
  document.getElementById("screenshot-root") as HTMLElement,
).render(<ScreenshotOverlay />);
