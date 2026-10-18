// 量一下取图命令的真实耗时（判断那 2 秒花在哪）。只读，不写任何东西。
(async () => {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) return "没有 __TAURI_INTERNALS__";
  const directory = "F:/VibeCoding_workspace/Verta";
  const names = [
    "屏幕截图 2026-05-17 131455.png",
    "局部截取_20261018_153945.png",
    "根本不存在的名字_20260101_000000.png",
  ];
  const out = [];
  for (const name of names) {
    const start = performance.now();
    const url = await invoke("agent_sessions_image", { name, directory });
    const elapsed = Math.round(performance.now() - start);
    out.push(`${elapsed}ms  ${name}  ->  ${url ? url.slice(0, 30) + "… (" + url.length + " 字节)" : "未命中"}`);
  }
  return out.join("\n");
})();