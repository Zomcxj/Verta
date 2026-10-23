import type { Theme } from "../types";

/**
 * The neutral gray theme inherited from upstream (the default here), named `Terax`.
 *
 * The `id` has to stay `verta-default`: stored preferences, the screenshot window, and
 * `DEFAULT_THEME_ID` all identify it by that id, so changing it would invalidate
 * everyone's choice (display name and id are separate things — only the display name
 * should follow the product).
 *
 * Note that the `verta` in this id is legacy baggage (this project is a fork of
 * Terax) and does **not** make it the brand theme; the brand theme is the separate
 * `themes/verta.ts`.
 *
 * Colours live in `styles/globals.css` (`:root` / `.dark`), not here:
 * ThemeProvider calls `clearTheme()` for this id instead of `applyTheme`, so
 * anything declared in `variants` would be dead and would drift. Empty
 * variants also let the settings swatch fall back to the live CSS vars.
 */
export const vertaDefault: Theme = {
  id: "verta-default",
  name: "Terax",
  description: "Clean neutral greys with a full-color terminal.",
  editorTheme: { dark: "github-dark", light: "github-light" },
  variants: {
    light: {},
    dark: {},
  },
};
