// Acrylic acceptance: report the current theme, the terminal background colour (alpha or not), the window
// material, and the state of the terminal canvases.
// Usage: node scripts/dev/webview-eval.mjs scripts/dev/probes/acrylic-terminal-state.js
//      Use --match=settings.html for the settings window
(() => {
  const root = document.documentElement;
  const terminalBackground = getComputedStyle(root)
    .getPropertyValue("--terminal-background")
    .trim();
  // Whether the terminal background carries alpha: resolve the colour once (an rgba alpha below 1 means translucent).
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;width:0;height:0;background-color:var(--terminal-background)";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  probe.remove();

  const canvases = [...document.querySelectorAll("[data-verta-terminal-canvas]")].map(
    (canvas) => {
      const rect = canvas.getBoundingClientRect();
      return {
        visible: getComputedStyle(canvas).visibility,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        backingScale:
          canvas.width > 0 && rect.width > 0
            ? Number((canvas.width / rect.width).toFixed(2))
            : null,
      };
    },
  );

  // The terminal pane's own DOM background: under a transparent theme it must not be a solid colour.
  const paneBackgrounds = [
    ...document.querySelectorAll("[data-verta-ghostty-surface]"),
  ].map((el) => ({
    kind: el.getAttribute("data-verta-ghostty-surface"),
    backgroundColor: getComputedStyle(el).backgroundColor,
  }));

  return {
    window: location.pathname,
    themeId: localStorage.getItem("verta-ui-theme-id-shadow"),
    vibrancy: root.getAttribute("data-vibrancy"),
    themeGlass: root.getAttribute("data-theme-glass"),
    themeSurface: root.getAttribute("data-theme-surface"),
    terminalBackground,
    terminalBackgroundResolved: resolved,
    terminalBackgroundHasAlpha: /^rgba\(/.test(resolved) && !/[,\s]1\)$/.test(resolved),
    canvasCount: canvases.length,
    canvases,
    paneBackgrounds,
  };
})();
