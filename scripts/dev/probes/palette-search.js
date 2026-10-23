// Search a word in the command palette and list the hits (from the user's point of view: which commands are
// findable, and whether they carry a shortcut badge).
//
// Usage: open the palette first with Ctrl+P in the main window, then run this probe (the probe cannot press
// Ctrl+P itself - the app does not receive a KeyboardEvent synthesized in the page, so use cdp-key.mjs).
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();

  const input =
    document.querySelector("[role='dialog'] input") ??
    document.querySelector("input[placeholder*='输入命令']") ??
    document.querySelector("input[placeholder*='command']");
  if (!input) {
    return JSON.stringify({ ok: false, step: "命令面板没开（先用 cdp-key.mjs 发 Ctrl+P）" });
  }

  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  ).set;
  const results = [];
  for (const query of ["终端", "删除", "关闭", "标签"]) {
    setValue.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(600);
    const rows = [...document.querySelectorAll("[role='option'], [cmdk-item]")].map((node) =>
      text(node).slice(0, 60),
    );
    results.push({
      搜: query,
      命中数: rows.length,
      命中: rows,
      "有「关闭标签页或面板」": rows.some((row) => row.includes("关闭标签页或面板")),
    });
  }
  return JSON.stringify({ ok: true, 结果: results }, null, 2);
})();
