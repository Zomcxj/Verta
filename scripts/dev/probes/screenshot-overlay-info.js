// 区域截图验收（2/3）：在**覆盖窗口**里报告它到底铺成了什么样。
//
// 要确认的三件事：整屏图有没有按 1/dpr 的比例铺满（像素一比一，不缩放）、
// 窗口内尺寸与整屏物理尺寸对不对得上、以及那句提示在不在。
(() => {
  const img = document.querySelector("img");
  const rect = img?.getBoundingClientRect();
  const layer = document.querySelector(".cursor-crosshair");
  return {
    dpr: window.devicePixelRatio,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    img: rect
      ? {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          naturalW: img.naturalWidth,
          naturalH: img.naturalHeight,
        }
      : null,
    hasSelectionLayer: !!layer,
    hint: (document.body.innerText || "").trim().slice(0, 80),
  };
})();