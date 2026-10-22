// 亚克力验收：报当前主题、终端底色（是否带 alpha）、窗口材质，以及终端画布的情况。
// 用法：node scripts/dev/webview-eval.mjs scripts/dev/probes/acrylic-terminal-state.js
//      设置窗口用 --match=settings.html
(() => {
  const root = document.documentElement;
  const terminalBackground = getComputedStyle(root)
    .getPropertyValue("--terminal-background")
    .trim();
  // 终端底色是否带 alpha：探针取一遍色值（rgba 的第四位小于 1 就是透的）。
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

  // 终端面板自己的 DOM 底色：透明主题下这里不该是实心色。
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
