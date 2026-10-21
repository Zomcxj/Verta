import "../styles/globals.css";

import { native } from "@/lib/native";
import { ScreenshotOverlay } from "@/modules/screenshot/ScreenshotOverlay";
import { loadPreferences, onPreferencesChange } from "@/modules/settings/store";
import { applyTheme, clearTheme } from "@/modules/theme/applyTheme";
import { getBuiltinTheme, getDefaultTheme } from "@/modules/theme/themes";
import { DEFAULT_THEME_ID, type ThemeMode } from "@/modules/theme/types";
import ReactDOM from "react-dom/client";

/**
 * 把这个窗口也铺上当前主题的 CSS 变量 —— 选区的边、把手、按钮都用主题色（`--primary` 那些）。
 *
 * 不套 ThemeProvider：它会渲染主题的背景层，那会盖住我们铺出来的冻结画面。这里只做它做的那件
 * 与颜色有关的事，而且 `verta-default` 这个 id 的颜色本来就在 globals.css 里，对它要清掉覆盖
 * （跟 ThemeProvider 一样走 `clearTheme`）。
 */
async function applyActiveTheme(): Promise<void> {
  const prefs = await loadPreferences();
  const mode: ThemeMode =
    prefs.theme === "dark" || prefs.theme === "light"
      ? prefs.theme
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  // 跟 index.html / settings.html 的启动脚本做同一件事：`--primary` 这些，浅色在 :root、
  // 深色在 .dark 里，根节点上没有这个类，主题色就取不到（描边会退成灰白）。
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(mode);
  const theme = getBuiltinTheme(prefs.themeId) ?? getDefaultTheme();
  if (theme.id === DEFAULT_THEME_ID) clearTheme();
  else applyTheme(theme, mode);
}

void applyActiveTheme();
// 截图窗口是养着的，期间用户在设置里换了主题（或系统切了深浅色）也得跟着变。
void onPreferencesChange(() => {
  void applyActiveTheme();
});
window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", () => {
    void applyActiveTheme();
  });

// 这个窗口是透明的：没被浅灰压到的像素要透出底下的屏幕本身。globals.css 给 body 铺了主题底色，
// 在这儿按窗口的性质覆盖掉（内联样式压得住它）。
document.documentElement.style.background = "transparent";
document.body.style.background = "transparent";

// 兜底：这个窗口是压在整屏上的，它自己的脚本万一崩了，窗口就该自己收起来——不然用户面前会
// 杵着一层点不动的灰，只能去任务管理器。脚本错误才收（资源加载失败之类的不算）。
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
