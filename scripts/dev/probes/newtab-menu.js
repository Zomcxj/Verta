// 列出当前菜单里的条目与屏幕坐标，供 cdp-key.mjs 发真实鼠标事件点开某一项。
(async () => {
  const rect = (node) => {
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  };
  const trigger = document.querySelector(
    "button[title='新标签页'], button[title='New tab'], button[title$='标签页']",
  );
  return JSON.stringify(
    {
      trigger: trigger ? rect(trigger) : null,
      items: [...document.querySelectorAll("[role='menuitem']")].map((node) => ({
        text: node.textContent?.trim(),
        ...rect(node),
      })),
    },
    null,
    2,
  );
})();