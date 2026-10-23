// Phase-one check: open a real image through IPC and see whether the editor renders a displayable <img>.
// Read-only: it writes no files.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lines = [];
  const IMAGE =
    "F:\\\\VibeCoding_workspace\\\\bear_bill\\\\assets\\\\app_icon.png";

  for (let i = 0; i < 40; i += 1) {
    if (document.querySelectorAll("button").length > 0) break;
    await sleep(500);
  }

  const invoke = window.__TAURI_INTERNALS__.invoke;
  // First check the file can be read at all (valid path, and classified as binary)
  try {
    const read = await invoke("fs_read_file", { path: IMAGE });
    lines.push(`fs_read_file -> kind=${read?.kind} size=${read?.size ?? "?"}`);
  } catch (error) {
    lines.push(`fs_read_file 失败: ${String(error)}`);
  }

  // Then go through the app's own "open file" entry point
  const before = document.querySelectorAll('[data-testid="editor-tab"]').length;
  let dispatched = false;
  for (const name of ["__vertaOpenFile", "verta:open-file"]) {
    const handle = window[name];
    if (typeof handle === "function") {
      try {
        handle(IMAGE);
        dispatched = true;
        lines.push(`调用 window.${name}()`);
      } catch (error) {
        lines.push(`${name} 调用失败: ${String(error)}`);
      }
    }
  }
  if (!dispatched) {
    window.dispatchEvent(
      new CustomEvent("verta:open-file", { detail: IMAGE }),
    );
    lines.push("派发 verta:open-file 事件（可能无人监听）");
  }
  await sleep(2500);

  const imgs = [...document.querySelectorAll("img")];
  const shown = imgs.filter((img) => {
    const rect = img.getBoundingClientRect();
    return rect.width > 40 && rect.height > 40;
  });
  lines.push(`页面 <img> 共 ${imgs.length} 个，其中可见(>40px) ${shown.length} 个`);
  for (const img of shown.slice(0, 3)) {
    const rect = img.getBoundingClientRect();
    lines.push(
      `  可见图: ${Math.round(rect.width)}x${Math.round(rect.height)} complete=${img.complete} natural=${img.naturalWidth}x${img.naturalHeight} src=${img.src.slice(0, 60)}`,
    );
  }
  const text = document.body.innerText;
  lines.push(`界面含 "Binary file": ${text.includes("Binary file")}`);
  lines.push(`界面含 "File too large": ${text.includes("File too large")}`);
  return lines.join("\n");
})();