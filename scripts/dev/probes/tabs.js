// 列出标签页与屏幕坐标，供 cdp-key.mjs 按序号点某个标签（用来验环境跟随）。
(async () => {
  const rect = (node) => {
    const r = node.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
    };
  };
  const tabs = [...document.querySelectorAll("[role='tab']")].map((node, i) => ({
    i,
    text: node.textContent?.trim(),
    active: node.getAttribute("aria-selected") === "true",
    ...rect(node),
  }));
  return JSON.stringify({ tabs }, null, 2);
})();