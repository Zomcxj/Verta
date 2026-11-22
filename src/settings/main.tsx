import "../styles/globals.css";

import { USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { ThemeProvider } from "@/modules/theme";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import { SettingsApp } from "./SettingsApp";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

ReactDOM.createRoot(
  document.getElementById("settings-root") as HTMLElement,
).render(
  <ThemeProvider>
    <SettingsApp />
  </ThemeProvider>,
);

/**
 * Show the window once it has something to show.
 *
 * This used to be two fixed timers (50 ms and 500 ms), which is a guess about how long a first paint
 * takes: on a cold open the page needs longer, and the reader was shown an empty window that filled
 * in afterwards ("启动后设置页面第一次打开会等一会"). A double animation frame is the paint itself, so
 * the window appears with its first card already drawn.
 *
 * The timers stay as a backstop: a page that never gets a frame (a hidden or throttled webview) must
 * still appear rather than leave the user with nothing.
 */
let shown = false;
const showWindow = () => {
  if (shown) return;
  shown = true;
  getCurrentWindow()
    .show()
    .catch((e) => console.error("settings show failed:", e));
};

requestAnimationFrame(() => {
  requestAnimationFrame(showWindow);
});
setTimeout(showWindow, 500);
