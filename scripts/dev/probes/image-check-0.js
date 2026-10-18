// 阶段一验证：让编辑器打开一张真实图片，确认 <img> 是否真的渲染出来。
// 只读操作：打开一个编辑器标签，不写任何文件。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const label = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const buttons = () => [...document.querySelectorAll("button")];
  const lines = [];

  for (let i = 0; i < 40; i += 1) {
    if (document.querySelectorAll("button").length > 0) break;
    await sleep(500);
  }
  lines.push(`界面就绪: 按钮 ${buttons().length} 个`);

  // Tauri 的 invoke 在 window.__TAURI_INTERNALS__ 上；用它直接开一个编辑器标签，
  // 避免依赖菜单点击的坐标。
  const tauri = window.__TAURI_INTERNALS__;
  lines.push(`__TAURI_INTERNALS__: ${tauri ? "存在" : "不存在"}`);
  return lines.join("\n");
})();