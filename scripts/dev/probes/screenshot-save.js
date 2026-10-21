// 区域截图验收：先把圆角拉到一个值，再点操作条上的「保存」，并把按下前的选区与圆角报出来
// （好跟落盘的文件对账）。
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const box = document.querySelector('[data-screenshot-ui="box"]');
  const style = box?.style;
  const selection = style
    ? {
        x: Math.round(parseFloat(style.left)),
        y: Math.round(parseFloat(style.top)),
        w: Math.round(parseFloat(style.width)),
        h: Math.round(parseFloat(style.height)),
        radius: style.borderRadius,
      }
    : null;

  const slider = document.querySelector('input[type="range"]');
  if (slider) {
    // React 认的是「原生 setter + input 事件」，直接改 .value 不会被它接住。
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(slider, "12");
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(120);
  }

  const save = [...document.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") || "") === "保存" || b.getAttribute("title") === "保存",
  );
  if (!save) {
    return {
      clicked: false,
      selection,
      buttons: [...document.querySelectorAll("button")].map((b) => ({
        aria: b.getAttribute("aria-label"),
        title: b.getAttribute("title"),
      })),
    };
  }
  save.click();
  await sleep(1800);
  return { clicked: true, selection, radiusAfter: slider?.value };
})();