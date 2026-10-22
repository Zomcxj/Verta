import type { Theme } from "../types";

/**
 * 名字是 `Terax`（软件自己的名字），但 `id` 必须留在 `verta-default`：已存的偏好、
 * 截图窗口与 `DEFAULT_THEME_ID` 都按这个 id 认它，改 id 等于让所有人的选择失效。
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
