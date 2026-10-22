import type { Theme } from "../types";

/**
 * 上游带过来的中性灰主题（本项目的默认），名字是 `Terax`。
 *
 * `id` 必须留在 `verta-default`：已存的偏好、截图窗口与 `DEFAULT_THEME_ID` 都按这个 id
 * 认它，改 id 等于让所有人的选择失效（显示名与 id 是两件事，只有显示名该跟着产品走）。
 *
 * 注意：这个 id 里的 `verta` 是历史包袱（本项目是 Terax 的 fork），**不代表**它就是
 * 品牌主题；品牌主题是另建的 `themes/verta.ts`。
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
