// Phase-one check: have the editor open a real image and confirm whether an <img> actually renders.
// Read-only: it opens an editor tab and writes no files.
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

  // Tauri's invoke lives on window.__TAURI_INTERNALS__; use it to open an editor tab directly,
  // so the measurement does not depend on menu-click coordinates.
  const tauri = window.__TAURI_INTERNALS__;
  lines.push(`__TAURI_INTERNALS__: ${tauri ? "存在" : "不存在"}`);
  return lines.join("\n");
})();