// Region-screenshot acceptance: measure how long one `screenshot_begin` takes from the main window.
//
// All this step does now is show the overlay window: no screen grab, no file write, no image swap, so it is the
// upper bound for "click to dim layer on screen". The gap between a cold start (the webview has to be created)
// and a warm one (the window is kept around) is visible at a glance.
(async () => {
  const started = performance.now();
  await window.__TAURI_INTERNALS__.invoke("screenshot_begin");
  return { ms: Math.round(performance.now() - started) };
})();