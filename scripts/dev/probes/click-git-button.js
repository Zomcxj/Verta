// Click the Git panel button in the top right directly (bypassing CDP input delivery) and report the effect as
// layout widths.
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
