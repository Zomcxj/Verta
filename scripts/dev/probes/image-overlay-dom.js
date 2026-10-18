// 诊断：列出文档里所有 data: 图片与位图按钮的位置，并附上最近一次扫描摘要。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(1000);
  const out = [];
  const images = [...document.querySelectorAll("img")];
  out.push(`img 总数: ${images.length}`);
  for (const image of images) {
    const src = image.getAttribute("src") ?? "";
    if (!src.startsWith("data:image/png")) continue;
    const rect = image.getBoundingClientRect();
    out.push(
      `   y=${Math.round(rect.top)} x=${Math.round(rect.left)} ${Math.round(rect.width)}x${Math.round(rect.height)} ${src.length}字节`,
    );
  }
  const button = [...document.querySelectorAll("button")].filter((element) =>
    (element.querySelector("img")?.getAttribute("src") ?? "").startsWith("data:image/png"),
  );
  out.push(`位图按钮: ${button.length}`);
  const scan = window.__vertaImageScan;
  out.push(
    scan
      ? `扫描: ${scan.references.length} 条引用, ${scan.tinted.filter((n) => n > 0).length} 行着色`
      : "扫描: 无",
  );
  return out.join("\n");
})();