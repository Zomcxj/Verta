(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(600);
  const out = [];
  let ok = true;
  [...document.querySelectorAll("table")].forEach((t, i) => {
    const wrap = t.parentElement;
    out.push(`表${i}: table宽=${Math.round(t.getBoundingClientRect().width)} 容器宽=${Math.round(wrap.getBoundingClientRect().width)} 表溢出=${t.getBoundingClientRect().width > wrap.getBoundingClientRect().width + 2}`);
    [...t.querySelectorAll("tr")].forEach((row, ri) => {
      const imgs = [...row.querySelectorAll("img")];
      if (!imgs.length) return;
      const hs = imgs.map((img) => Math.round(img.getBoundingClientRect().height));
      const fits = imgs.map((img) => {
        const td = img.closest("td,th").getBoundingClientRect();
        const r = img.getBoundingClientRect();
        return r.width <= td.width + 1;
      });
      const aligned = new Set(hs).size === 1;
      if (!aligned || fits.includes(false)) ok = false;
      out.push(`  行${ri}: 高度=[${hs.join(", ")}] 高度一致=${aligned} 都在单元格内=${fits.every(Boolean)}`);
    });
  });
  out.push(`总判定: ${ok ? "通过" : "不通过"}`);
  return out.join("\n");
})();
