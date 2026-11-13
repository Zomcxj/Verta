import "./styles/globals.css";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { AppErrorBoundary } from "./app/components/AppErrorBoundary";
import { initLaunchDir } from "./lib/launchDir";
import { USE_CUSTOM_WINDOW_CONTROLS } from "./lib/platform";
import { terminalDiagnosticsEnabled } from "@/modules/terminal/lib/terminalDiagnosticsEnabled";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

// Render-instrumentation overlay, opt-in: `VITE_REACT_SCAN=true pnpm dev`.
// Dev-only dynamic import so it never reaches the production bundle.
if (import.meta.env.DEV && import.meta.env.VITE_REACT_SCAN === "true") {
  const { scan } = await import("react-scan");
  scan({ enabled: true });
}

// Real-application benchmark (scripts/app-lab): scenario flags must be in force before any
// terminal module reads them. Removed entirely unless the build sets VERTA_BENCH=1.
if (__VERTA_BENCH__) {
  const { installBenchEarly } = await import("@/bench/early");
  await installBenchEarly();
}

// Reap PTY sessions orphaned by a prior webview load before any tab spawns, and seed the launch
// directory before the first paint so the default tab mounts at target cwd (no flicker). Neither
// needs the other's answer: one drains the sessions of a webview that is gone, the other reads the
// directory this launch was handed. Nothing paints until both are in, so they are issued together and
// the wait is the longer of the two rather than their sum.
await Promise.all([invoke("pty_close_all").catch(() => {}), initLaunchDir()]);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);

// Window starts hidden (per tauri.conf.json) so users never see a transparent
// shadow-only frame before React paints. Use setTimeout: rAF is throttled
// while the window is hidden and would never fire.
const showWindow = () => {
  getCurrentWindow()
    .show()
    .catch((e) => console.error("window.show failed:", e));
};
setTimeout(showWindow, 50);
// Safety net: if the first show somehow fails to take effect, force again.
setTimeout(showWindow, 500);

if (terminalDiagnosticsEnabled()) {
  void Promise.all([
    import("@/modules/terminal/lib/terminalDiagnostics"),
    import("@/app/sessionOpeningLog"),
    import("@/modules/terminal/lib/terminalSessionApi"),
  ]).then(([diagnostics, openings, api]) => {
    diagnostics.installTerminalDiagnostics(() => ({
      // How long each session-opening cover was up, what lifted it and what the leaf's screen showed
      // at that instant (`sessionOpeningLog.ts`). Supplied here rather than read by the terminal's
      // own diagnostics: the cover belongs to the application.
      sessionOpenings: openings.sessionOpeningRecords(),
      // One leaf's visible screen, so a probe can measure what the pane shows from moment to
      // moment while a cover is up, instead of reading a screenshot.
      screenTail: (leafId: number) => api.leafScreenTail(leafId),
    }));
  });
}

// DEV-only: what the session-opening cover waits on, so a probe can watch one open instead of
// inferring it from the code. Reads the same accessors the cover itself uses.
if (import.meta.env.DEV) {
  void import("@/modules/terminal/lib/terminalSessionApi").then((api) => {
    Object.assign(window, {
      __vertaLeafScreenTail: api.leafScreenTail,
      __vertaLeafUsesAlternateScreen: api.leafUsesAlternateScreen,
      __vertaLeafOutputBytes: api.leafOutputBytes,
    });
  });
}
