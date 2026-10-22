// 把所有跟窗口透明有关的变量与实际生效的背景一次性打出来。
(() => {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const read = (name) => style.getPropertyValue(name).trim();
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;width:0;height:0;background-color:var(--frame)";
  document.body.appendChild(probe);
  const frameResolved = getComputedStyle(probe).backgroundColor;
  probe.style.cssText =
    "position:fixed;width:0;height:0;background-color:var(--background)";
  const backgroundResolved = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return {
    window: location.pathname,
    htmlAttributes: [...root.attributes].map((a) => `${a.name}=${a.value}`),
    storedThemeId: localStorage.getItem("verta-ui-theme-id-shadow"),
    storedKeys: Object.keys(localStorage),
    card: read("--card"),
    background: read("--background"),
    frameRaw: read("--frame"),
    frameResolved,
    backgroundResolved,
    themeFrameOpacity: read("--theme-frame-opacity"),
    themePaneOpacity: read("--theme-pane-opacity"),
    themeGlassSheen: read("--theme-glass-sheen"),
    rootBackground: document.getElementById("root")
      ? getComputedStyle(document.getElementById("root")).backgroundColor
      : null,
    settingsRootBackground: document.getElementById("settings-root")
      ? getComputedStyle(document.getElementById("settings-root")).backgroundColor
      : null,
  };
})();
