// 区域截图验收（3/3）：在**主窗口**里报告收尾提示条的内容，以及「插入路径」按钮的坐标。
(() => {
  const toasts = [...document.querySelectorAll("[data-sonner-toast]")];
  const action = toasts
    .map((t) => t.querySelector("button"))
    .find((b) => b && b.innerText.trim().length > 0);
  const rect = action?.getBoundingClientRect();
  return {
    count: toasts.length,
    texts: toasts.map((t) => (t.innerText || "").replace(/\n/g, " | ")),
    action: action
      ? {
          label: action.innerText.trim(),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        }
      : null,
  };
})();