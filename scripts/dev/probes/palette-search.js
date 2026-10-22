// 在命令面板里搜一个词，把命中的条目列出来（用户视角：能搜到哪些命令、带不带快捷键角标）。
//
// 用法：先在主窗口发 Ctrl+P 打开面板，再跑这个探针（或由探针自己按 Ctrl+P 不行 —— 页面里合成的
// KeyboardEvent 应用收不到，得用 cdp-key.mjs）。
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
