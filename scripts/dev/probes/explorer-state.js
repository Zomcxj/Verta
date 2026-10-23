// Read the file tree on the left: the root path and the first-level entries (the title attribute carries the full path).
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const railButton = (label) =>
    [...document.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === label,
    );
  railButton("文件")?.click();
  await sleep(2500);
  const rows = [...document.querySelectorAll("[role='treeitem'], [data-path]")];
  const withTitle = [
    ...document.querySelectorAll("[title]"),
  ]
    .filter((node) => {
      const title = node.getAttribute("title") ?? "";
      return title.includes("/") || title.includes("\\");
    })
    .slice(0, 25)
    .map((node) => node.getAttribute("title"));
  return JSON.stringify(
    {
      树节点数: rows.length,
      带路径的标题: withTitle,
      可见文本: document.body.innerText.split("\n").slice(0, 18),
    },
    null,
    2,
  );
})();