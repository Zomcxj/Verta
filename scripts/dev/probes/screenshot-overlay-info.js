// 区域截图验收（2/3）：在**覆盖窗口**里报告它现在的样子。
//
// 要看得见的三件事：整屏图有没有按 1/dpr 铺满（像素一比一）、当前选区与把手、操作条上有哪些按钮。
(() => {
  const img = document.querySelector("img");
  const imgRect = img?.getBoundingClientRect();
  // 选区那一块的特征：用一圈夸张的 box-shadow 压暗框外。
  const selection = [...document.querySelectorAll("div")].find((d) =>
    (d.style.boxShadow || "").includes("100vmax"),
  );
  const style = selection?.style;
  return {
    dpr: window.devicePixelRatio,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    img: imgRect
      ? {
          left: Math.round(imgRect.left),
          top: Math.round(imgRect.top),
          w: Math.round(imgRect.width),
          h: Math.round(imgRect.height),
          naturalW: img.naturalWidth,
          naturalH: img.naturalHeight,
        }
      : null,
    selection: style
      ? {
          x: Math.round(parseFloat(style.left)),
          y: Math.round(parseFloat(style.top)),
          w: Math.round(parseFloat(style.width)),
          h: Math.round(parseFloat(style.height)),
        }
      : null,
    handles: [...document.querySelectorAll("[aria-label^='调整']")].map((h) => h.getAttribute("aria-label")),
    buttons: [...document.querySelectorAll("button")]
      .map((b) => (b.innerText || "").trim())
      .filter(Boolean),
    texts: (document.body.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean),
  };
})();