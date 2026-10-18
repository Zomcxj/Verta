(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const label = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const out = [];
  const leaf = (text) =>
    [...document.querySelectorAll("span, div")].find(
      (el) => el.children.length === 0 && label(el) === text,
    );

  // 双击进入 bear_bill（文件树的惯例是双击展开/进入）
  const target = leaf("bear_bill");
  out.push(`bear_bill 节点: ${target ? "找到" : "未找到"}`);
  if (target) {
    const opts = { bubbles: true, cancelable: true, view: window };
    target.dispatchEvent(new MouseEvent("dblclick", opts));
    await sleep(1500);
    const names = [...document.querySelectorAll("span, div")]
      .filter((el) => el.children.length === 0)
      .map(label)
      .filter((t) => t && t.length < 28 && !t.includes(" "))
      .slice(0, 40);
    out.push(`进入后可见: ${names.join(" | ")}`);
  }
  return out.join("\n");
})();
