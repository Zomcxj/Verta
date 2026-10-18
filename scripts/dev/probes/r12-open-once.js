(() => {
  const button = document.querySelector("button[title='显示/隐藏 Git 面板']");
  if (!button) return JSON.stringify({ ok: false });
  const panels = [...document.querySelectorAll("[data-panel]")];
  const right = panels[panels.length - 1];
  const collapsed = right.getBoundingClientRect().width <= 1;
  if (collapsed) button.click();
  return JSON.stringify({ opened: collapsed });
})();
