import { resolveFontFamily } from "@/lib/fonts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useEffect } from "react";

const CSS_VAR = "--editor-font-family";

/**
 * Write the editor font into a CSS variable.
 *
 * The font is the one setting shared by terminal and editor (`terminalFontFamily`),
 * and this follows the same pattern as font size: the CodeMirror theme is built once
 * at module level and its font stack cannot be changed, so the theme reads a variable
 * and this only keeps that variable up to date.
 */
export function useApplyEditorFontFamily(): void {
  const family = usePreferencesStore((s) => s.terminalFontFamily);

  useEffect(() => {
    document.documentElement.style.setProperty(
      CSS_VAR,
      resolveFontFamily(family),
    );
  }, [family]);
}
