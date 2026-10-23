// Click the "project name" button of one row in the project list (to verify behaviours like "a single click
// opens the workspace").
// The target project name prefix is set on the page as a global first: before running
//   node scripts/dev/webview-eval.mjs scripts/dev/probes/click-project.js
// run `__vertaPickProject = "<name>"` once (or fall back to the first row).
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
