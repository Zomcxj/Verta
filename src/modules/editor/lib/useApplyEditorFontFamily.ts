import { resolveFontFamily } from "@/lib/fonts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useEffect } from "react";

const CSS_VAR = "--editor-font-family";

/**
 * 把编辑器字体写进 CSS 变量。
 *
 * 字体是终端与编辑器共用的那一个设置项（`terminalFontFamily`）。与字号同一套路：
 * CodeMirror 的主题是模块级建一次的，改不了里面的字体栈，所以让它读变量，
 * 这里只负责把变量更新成最新的取值。
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
