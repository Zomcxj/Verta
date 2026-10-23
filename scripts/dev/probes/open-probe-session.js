// Open the probe session that carries image output, to verify "can the image be drawn once the terminal answers
// the pixel-size query".
// Read-only: it opens a session and writes no files.
(async () => {
  const TARGET_ID = "ses_verta_img_probe_0001";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const label = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const rows = () =>
    [...document.querySelectorAll("button")].filter(
      (b) => (b.getAttribute("title") ?? "").split("\n").length >= 3,
    );
  const out = [];

  for (let i = 0; i < 60; i += 1) {
    if (rows().length > 0) break;
    await sleep(500);
  }
  out.push(`会话行: ${rows().length} 条`);
  for (const row of rows()) {
    const title = (row.getAttribute("title") ?? "").split("\n")[0];
    const id = (row.getAttribute("title") ?? "").split("\n")[2];
    out.push(`   ${id} | ${title}`);
  }

  const target = rows().find(
    (row) => (row.getAttribute("title") ?? "").split("\n")[2] === TARGET_ID,
  );
  if (!target) return `${out.join("\n")}\n找不到 ${TARGET_ID}`;

  target.click();
  out.push(`已点击 ${TARGET_ID}`);
  await sleep(20000);
  out.push(`点击后按钮数: ${document.querySelectorAll("button").length}`);
  out.push(`canvas 数: ${document.querySelectorAll("canvas").length}`);
  return out.join("\n");
})();