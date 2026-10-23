// Verify search in "Settings → Shortcuts": can Chinese labels be found?
//
// Expected correct behaviour: searching the Chinese word for "terminal" finds the shortcuts whose label contains
// it; searching the word for "close" finds "close tab or pane".
// The current implementation matches against untranslated keys (`shortcut.closeTabOrPane`, group id `Tabs`), so
// Chinese never matches anything.
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();

  // Switch to the Shortcuts tab first (Radix tabs react to mousedown, so a bare click will not switch them)
  const tab = [...document.querySelectorAll("[role='tab']")].find((node) =>
    /快捷键/.test(text(node)),
  );
  if (!tab) {
    return JSON.stringify({
      ok: false,
      step: "没找到「快捷键」页签",
      页签: [...document.querySelectorAll("[role='tab']")].map(text),
    });
  }
  for (const type of ["mousedown", "mouseup", "click"]) {
    tab.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }));
  }
  await sleep(500);

  const input = [...document.querySelectorAll("input")].find((node) =>
    /搜索|search/i.test(node.placeholder ?? ""),
  );
  if (!input) {
    return JSON.stringify({
      ok: false,
      step: "没找到快捷键搜索框",
      输入框: [...document.querySelectorAll("input")].map((n) => n.placeholder),
    });
  }

  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  ).set;
  const snapshot = () => ({
    "有「关闭标签页或面板」": (document.body.innerText ?? "").includes("关闭标签页或面板"),
    可见分组: [...document.querySelectorAll("h3")].map(text),
  });

  const rows = [];
  for (const query of ["", "终端", "关闭", "标签", "tab", "ctrl+w"]) {
    setValue.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(400);
    rows.push({ 搜: query || "（不搜）", ...snapshot() });
  }
  return JSON.stringify({ ok: true, 结果: rows }, null, 2);
})();
