// Read-only snapshot: tab count / each tab's title and whether it is current / terminal leaf count / whether a
// confirm dialog is up / where focus is.
//
// Mainly for verifying shortcuts: read once before and once after a Ctrl+W and it is obvious whether the tab
// count changed.
// (It reads 0 if first paint has not finished, hence the wait for tabs to appear.)
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
