// 主窗口里「表面 / 纹理层 / 填充层」三层各自的位置、层级与谁在它们上面：
// 纹理在设置窗口看得见、在主窗口看不见，差别就在这几层上。
(() => {
  const info = (el) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === "string" ? el.className : "")
        .split(/\s+/)
        .slice(0, 4)
        .join(" "),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      zIndex: s.zIndex,
      position: s.position,
      display: s.display,
      opacity: s.opacity,
      blend: s.mixBlendMode,
      bgColor: s.backgroundColor,
      imageLen: s.backgroundImage.length,
      inset: [s.top, s.right, s.bottom, s.left].join(" "),
    };
  };
  const bodiesChildren = [...document.body.children].map((el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    cls: (typeof el.className === "string" ? el.className : "").split(/\s+/).slice(0, 3).join(" "),
    hasLayer: Boolean(el.querySelector("[data-theme-surface-layer]")),
  }));
  // 框架缝里那个点（左上角往里 4px 的位置）到底是谁画的。
  const at = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el ? `${el.tagName.toLowerCase()}.${(typeof el.className === "string" ? el.className : "").split(/\s+/).slice(0, 2).join(".")}` : null;
  };
  return {
    href: location.href,
    bodiesChildren,
    surface: info(document.querySelector(".verta-bg-surface")),
    layer: info(document.querySelector("[data-theme-surface-layer]")),
    fill: info(document.querySelector("[data-theme-surface-fill]")),
    layerParent: (() => {
      const l = document.querySelector("[data-theme-surface-layer]");
      return l?.parentElement ? `${l.parentElement.tagName.toLowerCase()}#${l.parentElement.id || ""}.${(typeof l.parentElement.className === "string" ? l.parentElement.className : "").split(/\s+/).slice(0, 3).join(".")}` : null;
    })(),
    layerSiblings: (() => {
      const l = document.querySelector("[data-theme-surface-layer]");
      if (!l?.parentElement) return null;
      return [...l.parentElement.children].map(
        (c, i) =>
          `${i === [...l.parentElement.children].indexOf(l) ? "-> " : "   "}${c.tagName.toLowerCase()}${c.id ? `#${c.id}` : ""}.${(typeof c.className === "string" ? c.className : "").split(/\s+/).slice(0, 2).join(".")}`,
      );
    })(),
    painterAt: {
      frameGapTop: at(270, 500),
      panelMiddle: at(140, 500),
      editorMiddle: at(600, 500),
    },
  };
})();