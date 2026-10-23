// Region-screenshot acceptance: attach timing to the overlay window for "message received → a frame is
// actually on screen".
//
// The user's original complaint was that it "pops" when opening. There is no frame freeze any more, so there
// is no "waiting for the image" phase; what needs proving is whether the overlay itself holds things up once
// the backend shows the window (ideally it paints within one frame).
//
// Why two probes, "install" and "read": install first (the window may still be in the background, where `rAF`
// may not even be running), then trigger a screenshot from the main window, then come back and read the numbers.
//
// The probe is a bare script and cannot import `@tauri-apps/api`, so it goes through the internals directly,
// the way that library does.
(async () => {
  const internals = window.__TAURI_INTERNALS__;
  const probe = { armed: null, firstFrameMs: null, settled: false };
  window.__armProbe = probe;
  const handler = internals.transformCallback(() => {
    probe.armed = Math.round(performance.now());
    const start = probe.armed;
    requestAnimationFrame(() => {
      // `rAF` is throttled while the window is hidden; coming back within one frame proves nothing extra is
      // added after it is shown.
      probe.firstFrameMs = Math.round(performance.now() - start);
      probe.settled = true;
    });
  });
  await internals.invoke("plugin:event|listen", {
    event: "screenshot:armed",
    target: { kind: "Any" },
    handler,
  });
  return { installed: true };
})();