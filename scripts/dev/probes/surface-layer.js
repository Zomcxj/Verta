// 纹理（主题 surface）到底画在哪个元素上、以什么不透明度与混合模式画：
// 主窗口与设置窗口是两份文档，同一套变量未必落在同一层上。
(() => {
  const describe = (el) => {
    const s = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === "string" ? el.className : "")
        .split(/\s+/)
        .slice(0, 3)
        .join(" "),
      image: (s.backgroundImage || "").slice(0, 70),
      imageLen: (s.backgroundImage || "").length,
      bgColor: s.backgroundColor,
      size: s.backgroundSize,
      repeat: s.backgroundRepeat,
      opacity: s.opacity,
      blend: s.mixBlendMode,
      display: s.display,
    };
  };
  const html = document.documentElement;
  const d = getComputedStyle(html);
  const layers = [...document.querySelectorAll("[data-theme-surface-layer]")];
  const fills = [...document.querySelectorAll("[data-theme-surface-fill]")];
  return {
    href: location.href,
    theme: localStorage.getItem("verta-ui-theme-id-shadow"),
    mode: localStorage.getItem("verta-ui-theme-shadow"),
    htmlClass: html.className,
    surfaceFlag: html.getAttribute("data-theme-surface"),
    varsForSurface: {
      image: d.getPropertyValue("--theme-surface-image").trim().length,
      opacity: d.getPropertyValue("--theme-surface-opacity").trim(),
      blend: d.getPropertyValue("--theme-surface-blend").trim(),
      background: d.getPropertyValue("--theme-surface-background").trim(),
    },
    body: describe(document.body),
    layers: layers.map(describe),
    fills: fills.map(describe),
  };
})();