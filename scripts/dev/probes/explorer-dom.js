(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const label = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  await sleep(500);
  const pane = document.querySelector('[class*="terax-pane"]');
  const out = [`侧栏 pane 存在: ${!!pane}`];
  // 找含文件名的行（docs 目录是第一层）
  const rows = [...document.querySelectorAll('div[role="treeitem"], [data-explorer-row], li')];
  out.push(`treeitem/li 数量: ${rows.length}`);
  const texts = [...document.querySelectorAll("*")]
    .filter((el) => el.children.length === 0 && label(el) === "docs")
    .slice(0, 3);
  out.push(`含 "docs" 的叶子文本节点: ${texts.length}`);
  // 列出侧栏里所有短文本（可能是文件名）
  const names = [...document.querySelectorAll("span, div")]
    .filter((el) => el.children.length === 0)
    .map(label)
    .filter((t) => t && t.length < 24 && !t.includes(" "))
    .slice(0, 40);
  out.push(`短文本: ${names.join(" | ")}`);
  return out.join("\n");
})();
