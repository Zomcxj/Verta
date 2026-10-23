// The Chinese name and description of every entry in the settings page's theme list, to check that a new theme's
// copy matches the style of the rest.
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