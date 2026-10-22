// 只读快照：标签数 / 每个标签的标题与是否当前 / 终端叶子数 / 有没有弹确认框 / 焦点在哪。
//
// 主要用来验快捷键：按一次 Ctrl+W 前后各读一次，标签数变没变一目了然。
// （首屏没渲染完会读到 0，所以先等标签出现。）
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 60; i += 1) {
    if (document.querySelectorAll("[role='tab']").length > 0) break;
    await sleep(250);
  }
  const text = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  const tabs = [...document.querySelectorAll("[role='tab']")];
  const active = document.activeElement;
  return JSON.stringify(
    {
      标签数: tabs.length,
      标签: tabs.map((tab) => ({
        标题: text(tab).slice(0, 24),
        当前: tab.getAttribute("aria-selected") === "true",
      })),
      终端叶子: document.querySelectorAll("[data-pane-leaf]").length,
      弹框: document.querySelector('[role="alertdialog"], [role="dialog"]')
        ? text(document.querySelector('[role="alertdialog"], [role="dialog"]')).slice(0, 60)
        : null,
      焦点: active ? `${active.tagName}${active.className ? `.${String(active.className).split(" ")[0]}` : ""}` : null,
    },
    null,
    2,
  );
})();
