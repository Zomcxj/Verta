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
 * Show this window, and dim the one behind it at the same time.
 *
 * The two used to be sequenced - `show()` first, the mask in its `.then` - on the reasoning that the
 * mask must never be up while there is nothing on top of it. That is right about the *click* (the
 * window is built on a first open, which is hundreds of milliseconds) and wrong about this moment:
 * both are one IPC call away from Rust, so awaiting the first before sending the second put a whole
 * round trip between the window appearing and the mask appearing. Reported as "打开用量的同时出现蒙版
 * 现在蒙版出现慢了" - the window is up, undimmed, and the mask lands a beat later.
 *
 * So both are sent together. `show` failing lowers the mask again, which keeps the original promise
 * without paying for it in the common case.
 */
const USAGE_WINDOW_EVENT = "verta:usage-window";

const reveal = () => {
  const window_ = getCurrentWindow();
  // Sent first and not awaited: the mask is a state change in the window behind, and asking for it
  // in the same tick as the show is what makes the two land in one frame.
  void emitTo("main", USAGE_WINDOW_EVENT, true).catch(() => {});
  void window_.show().catch((e) => {
    console.error("usage show failed:", e);
    // A window that never appeared must not leave the one behind it dimmed.
    void emitTo("main", USAGE_WINDOW_EVENT, false).catch(() => {});
  });
};
// Shown once it has something to show: a double animation frame is the paint itself, so the window
// appears with its first card drawn rather than empty and filling in afterwards. It used to be
// called as soon as this module ran, which is before React has rendered anything.
//
// The timer stays as a backstop for a webview that never gets a frame.
let revealed = false;
const revealOnce = () => {
  if (revealed) return;
  revealed = true;
  reveal();
};
requestAnimationFrame(() => {
  requestAnimationFrame(revealOnce);
});
setTimeout(revealOnce, 500);
