// 点击项目列表里某一行的「项目名」按钮（验「单击进工作区」等行为）。
// 目标项目名前缀先由页面全局设定：
//   node scripts/dev/webview-eval.mjs scripts/dev/probes/click-project.js 之前，
//   先跑一次 __vertaPickProject = "<名字>"（或用默认的第一行）。
(() => {
  const nodes = [...document.querySelectorAll("table tbody tr button")].filter(
    (candidate) => candidate.textContent?.trim(),
  );
  const want = window.__vertaPickProject;
  const node = want
    ? nodes.find((candidate) => candidate.textContent?.trim().startsWith(want))
    : nodes[0];
  if (!node) return JSON.stringify({ clicked: false, reason: "没找到那一行的项目名按钮" });
  node.click();
  return JSON.stringify({ clicked: true, name: node.textContent?.trim() });
})();
