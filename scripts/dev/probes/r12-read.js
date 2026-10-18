(() => {
  const panels = [...document.querySelectorAll("[data-panel]")].map((n) => Math.round(n.getBoundingClientRect().width));
  const button = document.querySelector("button[title='显示/隐藏 Git 面板']");
  const right = [...document.querySelectorAll("[data-panel]")].pop();
  const text = right ? right.innerText.replace(/\n+/g, " | ").slice(0, 300) : null;
  return JSON.stringify({
    panels,
    badge: button?.querySelector("span")?.textContent ?? null,
    rightPanelText: text,
    store: {
      width: window.localStorage.getItem("verta.rightPanel.width"),
      collapsed: window.localStorage.getItem("verta.rightPanel.collapsed"),
    },
  }, null, 2);
})();
