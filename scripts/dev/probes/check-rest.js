(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(1500);
  const out = [];
  // 顶部按钮的 title
  const titled = [...document.querySelectorAll("[title]")].map((e) => e.getAttribute("title"));
  out.push(`带 title 的元素数: ${titled.length}`);
  out.push(`剩余英文 title: ${titled.filter((x) => /^[A-Za-z][A-Za-z ]{2,}$/.test(x)).slice(0, 10).join(" | ") || "无"}`);
  const aria = [...document.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label"));
  out.push(`剩余英文 aria-label: ${aria.filter((x) => /^[A-Za-z][A-Za-z ]{2,}$/.test(x)).slice(0, 10).join(" | ") || "无"}`);
  return out.join("\n");
})();
