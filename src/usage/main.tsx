import "../styles/globals.css";

import { TooltipProvider } from "@/components/ui/tooltip";
import { USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { ThemeProvider } from "@/modules/theme";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import { UsageApp } from "./UsageApp";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

ReactDOM.createRoot(
  document.getElementById("usage-root") as HTMLElement,
).render(
  <ThemeProvider>
    <TooltipProvider>
      <UsageApp />
    </TooltipProvider>
  </ThemeProvider>,
);

/**
 * Show this window, then dim the one behind it.
 *
 * The order is the point: the main window's scrim is what tells the reader something opened on top
 * of it, so it must not be up while there is nothing there yet. It used to be emitted from Rust the
 * moment this webview was built, which is a few frames before it paints, and the mask alone was
 * visible for that gap on a first open.
 *
 * `show` first and the event second: a window that failed to appear leaves the window behind it
 * undimmed, instead of a mask over nothing.
 */
const reveal = () => {
  void getCurrentWindow()
    .show()
    .then(() => emitTo("main", "verta:usage-window", true))
    .catch((e) => console.error("usage show failed:", e));
};
setTimeout(reveal, 50);
setTimeout(reveal, 500);
