(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const label = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const buttons = () => [...document.querySelectorAll("button")];
  const out = [];

  const filesBtn = buttons().find((b) => label(b) === "Files");
  out.push(`Files 轨道按钮: ${filesBtn ? "找到" : "未找到"}`);
  filesBtn?.click();
  await sleep(900);

  // 文件树行的特征：带 path 或 aria-label
  const nodes = [...document.querySelectorAll('[role="treeitem"], [data-path], button, div')].filter(
    (el) => {
      const t = el.getAttribute("data-path") ?? el.getAttribute("aria-label") ?? "";
      return t.length > 0 && t.length < 200;
    },
  );
  out.push(`候选节点: ${nodes.length}`);
  const paths = nodes
    .map((el) => el.getAttribute("data-path") ?? el.getAttribute("aria-label") ?? "")
    .filter((t) => t.length > 1)
    .slice(0, 12);
  out.push(`样例: ${paths.join(" | ")}`);
  return out.join("\n");
})();
