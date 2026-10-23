// 设置页主题列表里每一项的中文名与说明，用来核对新主题的文案风格是否与其余一致。
(() => {
  const out = [];
  for (const el of document.querySelectorAll("span")) {
    const cls = typeof el.className === "string" ? el.className : "";
    if (!cls.includes("[11px]")) continue;
    const parent = el.parentElement;
    const name =
      parent?.querySelector("span")?.textContent?.replace(/\s+/g, " ").trim() ??
      "";
    out.push({ name, desc: (el.textContent ?? "").trim() });
  }
  return out;
})();