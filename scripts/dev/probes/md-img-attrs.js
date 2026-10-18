(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(300);
  const out = [];
  for (const img of document.querySelectorAll("table img")) {
    const cs = getComputedStyle(img);
    out.push(
      `attr: height=${img.getAttribute("height")} width=${img.getAttribute("width")} | computed: ${cs.width} x ${cs.height} | class="${img.className}"`,
    );
  }
  return out.join("\n");
})();
