// R12 acceptance: right panel width / collapsed state persistence, the badge, and collapsing again on a second
// click.
(() => {
  const panels = () => [...document.querySelectorAll("[data-panel]")].map((n) => Math.round(n.getBoundingClientRect().width));
  const button = document.querySelector("button[title='显示/隐藏 Git 面板']");
  const store = {
    width: window.localStorage.getItem("verta.rightPanel.width"),
    collapsed: window.localStorage.getItem("verta.rightPanel.collapsed"),
    sidebarView: window.localStorage.getItem("verta.sidebar.view"),
  };
  const badge = button?.querySelector("span")?.textContent ?? null;
  const body = document.body.innerText;
  return JSON.stringify({
    panels: panels(),
    store,
    badge,
    hasGitViewText: body.includes("暂存") || body.includes("Stage") || body.includes("没有改动") || body.includes("No changes"),
    sample: body.slice(0, 0),
  }, null, 2);
})();
