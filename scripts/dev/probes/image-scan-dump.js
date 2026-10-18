// 诊断：打印终端当前可见行的原始文本，以及图片检测结果。只读。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(1500);
  const scan = window.__vertaImageScan;
  if (!scan) return "没有扫描结果（叠加层未运行）";
  const out = [`可见行 ${scan.rows.length} 条`, `检测结果 ${scan.references.length} 条`];
  for (const reference of scan.references) {
    out.push(
      `   ${reference.name} 行 ${reference.topLine}-${reference.bottomLine} 列 ${reference.leftColumn}-${reference.rightColumn}`,
    );
  }
  for (const [index, row] of scan.rows.entries()) {
    if (!row) continue;
    out.push(`${String(index).padStart(2, "0")}| ${row.slice(0, 110)}`);
  }
  return out.join("\n");
})();