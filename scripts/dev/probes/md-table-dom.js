(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(400);
  const tables = [...document.querySelectorAll("table")];
  const out = [`table 数量: ${tables.length}`];
  for (const t of tables.slice(0, 2)) {
    const td = t.querySelector("td");
    const img = t.querySelector("img");
    out.push(`  table class="${t.className}"`);
    out.push(`  table 是否有 wrapper: ${t.parentElement?.tagName}.${t.parentElement?.className}`);
    if (td && img) {
      const tdr = td.getBoundingClientRect();
      const ir = img.getBoundingClientRect();
      out.push(`  td ${Math.round(tdr.width)}px  img ${Math.round(ir.width)}px  溢出=${ir.width > tdr.width}`);
      out.push(`  img class="${img.className}" style="${img.getAttribute("style") ?? ""}" height="${img.getAttribute("height")}" width="${img.getAttribute("width")}"`);
      out.push(`  td overflow style: ${getComputedStyle(td).overflow}`);
    }
  }
  return out.join("\n");
})();
