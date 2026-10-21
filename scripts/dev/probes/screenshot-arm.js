// 区域截图验收（1/3）：在**主窗口**里找右上角那个「截图」按钮。
//
// 交回它的中心坐标（给 cdp-input.mjs 发真点击）与 devicePixelRatio（算物理像素要用），
// 顺带把同一排的按钮标题列出来，确认它就挨着 Git 面板那个按钮。
(() => {
  const wanted = ["截图", "Screenshot"];
  const buttons = [...document.querySelectorAll("button")];
  const button = buttons.find((b) => wanted.includes(b.getAttribute("title")));
  if (!button) {
    return {
      found: false,
      titles: buttons.map((b) => b.getAttribute("title")).filter(Boolean).slice(0, 20),
    };
  }
  const rect = button.getBoundingClientRect();
  return {
    found: true,
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    dpr: window.devicePixelRatio,
    row: [...(button.parentElement?.querySelectorAll("button") ?? [])]
      .map((b) => b.getAttribute("title"))
      .filter(Boolean),
  };
})();