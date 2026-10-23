// Report the management state read-only, to check the result after a real OS mouse click.
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

  for (let i = 0; i < 20; i += 1) {
    if (buttons().length > 0) break;
    await sleep(250);
  }
  const dialog = document.querySelector('[role="alertdialog"]');
  return [
    `管理态: ${find("完成") ? "是" : "否"}`,
    `确认框: ${dialog ? "是" : "否"}`,
    dialog ? `确认框文本: ${label(dialog)}` : "",
    `底部: ${selected()}`,
    `会举行数: ${rows().length}`,
    `删除按钮 disabled: ${find("删除")?.disabled}`,
  ]
    .filter(Boolean)
    .join("\n");
})();