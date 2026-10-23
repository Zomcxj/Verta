// 设置页当前的外观模式与选中的主题（读界面状态，不改任何东西）。
(() => {
  const pick = (re) => {
    const out = [];
    for (const el of document.querySelectorAll(
      "button,[role=radio],[role=tab],[role=button],[data-state]",
    )) {
      const label = (el.getAttribute("aria-label") || el.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!label || label.length > 24 || !re.test(label)) continue;
      out.push({
        label,
        state: el.getAttribute("data-state"),
        checked: el.getAttribute("aria-checked"),
        selected: el.getAttribute("aria-selected"),
        cls: (typeof el.className === "string" ? el.className : "")
          .split(/\s+/)
          .filter((c) => /bg-|text-|selected|active/.test(c))
          .slice(0, 3),
      });
    }
    return out;
  };
  const root = document.documentElement;
  return {
    appearance: pick(/^(深色|浅色|跟随系统|Dark|Light|System)$/),
    themeCardSelected: pick(/^(Verta|Acrylic|Carbon Fiber|Terax)$/),
    htmlAttrs: {
      appearance: root.getAttribute("data-appearance"),
      theme: root.getAttribute("data-theme"),
      cls: (root.className || "").split(/\s+/).slice(0, 5),
    },
    frameBg: getComputedStyle(root).getPropertyValue("--frame").trim(),
    bg: getComputedStyle(root).getPropertyValue("--background").trim(),
  };
})();