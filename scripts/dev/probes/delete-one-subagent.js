// 真删除一条子代理会话（用户已授权），用于验证删除的成功路径。
// 关键安全点：点确认之前先断言「被选中的恰好是目标那一条」，不是就放弃。
(async () => {
  const TARGET_ID = "ses_eda8cfdc5ffeN3XYbjTRWiSx92";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const label = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const buttons = () => [...document.querySelectorAll("button")];
  const find = (name) => buttons().find((b) => label(b) === name);
  const rows = () => buttons().filter((b) => (b.getAttribute("title") ?? "").split("\n").length >= 3);
  const titleOf = (row) => (row.getAttribute("title") ?? "").split("\n")[0];
  const idOf = (row) => (row.getAttribute("title") ?? "").split("\n")[2];
  const selectedRows = () => rows().filter((row) => row.querySelector('[data-checked="true"]'));
  const selectedText = () => {
    const span = [...document.querySelectorAll("span")].find((s) => label(s).startsWith("已选"));
    return label(span?.parentElement);
  };
  const lines = [];

  for (let i = 0; i < 60; i += 1) {
    if (buttons().length > 0) break;
    await sleep(500);
  }
  if (!find("完成")) {
    find("管理")?.click();
    await sleep(400);
  }
  // 先把可能残留的选择清掉，保证下面只选中目标这一条
  if (selectedRows().length > 0) {
    find("清空")?.click();
    await sleep(300);
    lines.push(`已清空残留选择: ${selectedText()}`);
  }
  lines.push(`管理态: ${find("完成") ? "是" : "否"}，会举行数: ${rows().length}`);

  const target = rows().find((row) => idOf(row) === TARGET_ID);
  if (!target) return `${lines.join("\n")}\n找不到目标 ${TARGET_ID}，放弃`;

  target.click();
  await sleep(300);
  const chosen = selectedRows();
  lines.push(`勾选后: ${selectedText()}；被选中行: ${chosen.map((r) => `[${titleOf(r)}](${idOf(r)})`).join(" ")}`);
  if (chosen.length !== 1 || idOf(chosen[0]) !== TARGET_ID) {
    return `${lines.join("\n")}\n选中的不是目标本身，已放弃，未删除任何东西`;
  }

  find("删除")?.click();
  await sleep(500);
  const dialog = document.querySelector('[role="alertdialog"]');
  if (!dialog) return `${lines.join("\n")}\n确认框没出现，放弃（未删除）`;
  lines.push(`确认框: ${label(dialog)}`);

  const confirm = [...dialog.querySelectorAll("button")].find((b) => label(b) === "删除");
  if (!confirm) return `${lines.join("\n")}\n确认框里没有确认按钮，放弃（未删除）`;
  lines.push("已确认，执行删除…");
  confirm.click();
  await sleep(2500);

  lines.push(`删除后: ${selectedText()}；会举行数: ${rows().length}`);
  lines.push(`目标还在列表里吗: ${rows().some((row) => idOf(row) === TARGET_ID) ? "还在（删除失败）" : "已消失"}`);
  const error = [...document.querySelectorAll("div")].find((d) =>
    label(d).startsWith("有 ") && label(d).includes("没能删除"),
  );
  lines.push(`失败提示: ${error ? label(error) : "无"}`);
  return lines.join("\n");
})();