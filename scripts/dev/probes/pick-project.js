// 列出项目行里「项目名」按钮的文本与坐标，供 cdp-key.mjs 悬停或点击。
(() =>
  JSON.stringify(
    [...document.querySelectorAll("table tbody tr button")].map((node) => {
      const r = node.getBoundingClientRect();
      return {
        name: node.textContent?.trim(),
        x: Math.round(r.left + Math.min(r.width, 220) / 2),
        y: Math.round(r.top + r.height / 2),
      };
    }),
    null,
    1,
  ))();