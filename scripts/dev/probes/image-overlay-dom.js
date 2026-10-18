// 诊断：叠加层是否挂载、是否拿到了图片数据。只读。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  for (let i = 0; i < 30; i += 1) {
    if (document.querySelectorAll("canvas").length > 0) break;
    await sleep(500);
  }
  const images = [...document.querySelectorAll("img")].map((el) => ({
    src: (el.getAttribute("src") ?? "").slice(0, 40),
    w: Math.round(el.getBoundingClientRect().width),
    h: Math.round(el.getBoundingClientRect().height),
  }));
  out.push(`img 元素: ${images.length}`);
  for (const image of images.slice(0, 8)) out.push(`   ${image.w}x${image.h} ${image.src}`);

  const overlays = [...document.querySelectorAll("div")].filter((el) =>
    (el.className ?? "").toString().includes("pointer-events-none absolute inset-0 z-10"),
  );
  out.push(`叠加层容器: ${overlays.length}`);
  for (const overlay of overlays.slice(0, 4)) {
    out.push(`   子元素 ${overlay.children.length}: ${[...overlay.children].map((c) => c.tagName + "." + (c.className ?? "").toString().slice(0, 24)).join(" | ")}`);
  }
  return out.join("\n");
})();