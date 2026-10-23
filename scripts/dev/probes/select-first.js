// Tick only the first session row, for the "real OS mouse click" control experiment.
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const label = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const buttons = () => [...document.querySelectorAll("button")];
  const find = (name) => buttons().find((b) => label(b) === name);
  const rows = () => buttons().filter((b) => (b.getAttribute("title") ?? "").split("\n").length >= 3);
  const selected = () => {
    const span = [...document.querySelectorAll("span")].find((s) => label(s).startsWith("已选"));
    return label(span?.parentElement);
  };

  for (let i = 0; i < 60; i += 1) {
    if (buttons().length > 0) break;
    await sleep(500);
  }
  if (!find("完成")) {
    find("管理")?.click();
    await sleep(300);
  }
  rows()[0]?.click();
  await sleep(200);
  const rect = find("删除")?.getBoundingClientRect();
  return [
    `勾选后: ${selected()}`,
    `删除按钮 disabled: ${find("删除")?.disabled}`,
    `删除按钮矩形: ${JSON.stringify({ x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) })}`,
    `删除按钮中心(客户区坐标): ${Math.round(rect.x + rect.width / 2)}, ${Math.round(rect.y + rect.height / 2)}`,
  ].join("\n");
})();