// R12 验收：右上 Git 面板按钮、左栏项、右栏内容是否可见。
(() => {
  const rectOf = (node) => {
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) };
  };
  const gitButton = document.querySelector("button[title='显示/隐藏 Git 面板']");
  const rail = [...document.querySelectorAll("button[aria-pressed]")]
    .filter((node) => node.textContent?.trim())
    .map((node) => node.textContent?.trim());
  const panel = document.querySelector("[data-panel-id='gitPanel']");
  const text = document.body.innerText;
  return JSON.stringify(
    {
      gitButton: gitButton ? rectOf(gitButton) : null,
      gitButtonTitle: gitButton ? gitButton.title : null,
      gitButtonBadge: gitButton?.querySelector("span")?.textContent ?? null,
      rail,
      rightPanelWidth: panel ? rectOf(panel).w : null,
      rightPanelHasGit: text.includes("暂存") || text.includes("Stage"),
    },
    null,
    2,
  );
})();