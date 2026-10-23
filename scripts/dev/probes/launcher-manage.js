// Acceptance probe for the session management state: read the DOM and fire real clicks on it, never confirming
// any deletion.
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const label = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const buttons = () => [...document.querySelectorAll("button")];
  const find = (name) => buttons().find((b) => label(b) === name);
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const selected = () => {
    const span = [...document.querySelectorAll("span")].find((s) => label(s).startsWith("已选"));
    return label(span?.parentElement);
  };
  const rows = () => buttons().filter((b) => (b.getAttribute("title") ?? "").split("\n").length >= 3);
  const lines = [];

  // The port is up as soon as WebView2 starts while React may not have mounted yet, so wait for the UI to appear.
  for (let i = 0; i < 60; i += 1) {
    if (buttons().length > 0) break;
    await sleep(500);
  }
  lines.push(`诊断: title=${document.title} url=${location.href} body子元素=${document.body.childElementCount} 按钮数=${buttons().length}`);

  if (!find("完成")) {
    find("管理")?.click();
    await sleep(300);
  }
  lines.push(`管理态(完成按钮存在): ${find("完成") ? "是" : "否"}`);
  lines.push(`底部按钮矩形: ${["全选", "清空", "删除"].map((n) => `${n}@${JSON.stringify(rect(find(n)))}`).join("  ")}`);
  lines.push(`底部整行: ${selected()}`);
  lines.push(`会举行数(含子代理): ${rows().length}`);

  rows()[0]?.click();
  await sleep(200);
  lines.push(`点第一行后: ${selected()}`);
  lines.push(`删除按钮 disabled: ${find("删除")?.disabled}`);

  find("删除")?.click();
  await sleep(400);
  const dialog = document.querySelector('[role="alertdialog"]');
  lines.push(`确认框出现: ${dialog ? "是" : "否"}`);
  if (dialog) lines.push(`确认框文本: ${label(dialog)}`);

  find("取消")?.click();
  await sleep(400);
  lines.push(`取消后仍有确认框: ${document.querySelector('[role="alertdialog"]') ? "是" : "否"}`);
  lines.push(`取消后已选: ${selected()}`);
  return lines.join("\n");
})();