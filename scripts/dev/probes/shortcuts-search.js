// 验「设置 → 快捷键」的搜索：中文标签能不能被搜到。
//
// 预期的正确行为：搜「终端」应当能搜到带「终端」字样的快捷键；搜「关闭」应当能搜到「关闭标签页或面板」。
// 当前实现拿的是没翻译的 key（`shortcut.closeTabOrPane` / 分组 id `Tabs`）做匹配，所以中文一律搜不到。
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();

  // 先切到「快捷键」页签（Radix 的页签认 mousedown，光 click 切不过去）
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
