// 直接点右上角 Git 面板按钮（绕开 CDP 输入投递），并用布局宽度回报效果。
(() => {
  const button = document.querySelector("button[title='显示/隐藏 Git 面板']");
  if (!button) return JSON.stringify({ clicked: false, reason: "按钮不在" });
  button.click();
  const panels = [...document.querySelectorAll("[data-panel]")].map((node) => ({
    id: node.getAttribute("data-panel-id") ?? node.getAttribute("data-panel"),
    width: Math.round(node.getBoundingClientRect().width),
  }));
  return JSON.stringify({ clicked: true, panels }, null, 2);
})();
