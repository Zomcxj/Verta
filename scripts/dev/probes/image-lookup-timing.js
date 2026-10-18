// 逐个量取图命令：命中/未命中与耗时。只读。
(async () => {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) return "没有 __TAURI_INTERNALS__";
  const cases = [
    ["F:/VibeCoding_workspace/PasteLabel", "局部截取_20261018_164109.png"],
    ["F:/VibeCoding_workspace/Verta", "clipboard"],
    ["F:/VibeCoding_workspace/Verta", "局部截取_20261018_163058.png"],
  ];
  const out = [];
  for (const [directory, name] of cases) {
    const start = performance.now();
    const url = await invoke("agent_sessions_image", { name, directory });
    out.push(
      `${Math.round(performance.now() - start)}ms  ${name}  ->  ${url ? url.length + " 字节" : "未命中"}`,
    );
  }
  return out.join("\n");
})();