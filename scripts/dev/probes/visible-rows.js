(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const label = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  await sleep(1200); // let Vite HMR apply
  const rows = [...document.querySelectorAll("button")].filter(
    (b) => (b.getAttribute("title") ?? "").split("\n").length >= 3,
  );
  const out = [`界面可见会话行: ${rows.length} 条`];
  for (const r of rows) {
    const title = (r.getAttribute("title") ?? "").split("\n")[0];
    const isSub = label(r).includes("子代理");
    out.push(`   ${isSub ? "[子代理] " : ""}${title}`);
  }
  const footer = [...document.querySelectorAll("div")].find((d) =>
    /^\d+ 条$/.test(label(d)),
  );
  out.push(`底部计数: ${footer ? label(footer) : "未找到"}`);
  return out.join("\n");
})();
