(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(300);
  const out = [];
  const tables = [...document.querySelectorAll("table")];
  tables.forEach((t, ti) => {
    const wrap = t.parentElement;
    const tr = t.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    out.push(`表 ${ti}: table=${Math.round(tr.width)}px wrapper=${Math.round(wr.width)}px 表溢出=${tr.width > wr.width + 1}`);
    const rows = [...t.querySelectorAll("tr")];
    rows.forEach((row, ri) => {
      const tds = [...row.querySelectorAll("td,th")];
      tds.forEach((td, ci) => {
        const img = td.querySelector("img");
        if (!img) return;
        const tdr = td.getBoundingClientRect();
        const ir = img.getBoundingClientRect();
        const natural = `${img.naturalWidth}x${img.naturalHeight}`;
        const ratioShown = (ir.width / ir.height).toFixed(3);
        const ratioNat = (img.naturalWidth / img.naturalHeight).toFixed(3);
        out.push(
          `  行${ri}列${ci}: td=${Math.round(tdr.width)}x${Math.round(tdr.height)} img=${Math.round(ir.width)}x${Math.round(ir.height)} 原始=${natural}`,
        );
        out.push(
          `      图片溢出单元格=${ir.width > tdr.width + 1 || ir.height > tdr.height + 1} 宽高比失真=${ratioShown !== ratioNat}(${ratioShown} vs ${ratioNat})`,
        );
        out.push(`      图片底边是否超出单元格=${Math.round(ir.bottom)} > ${Math.round(tdr.bottom)}`);
      });
    });
  });
  return out.join("\n");
})();
