// What does the tab strip actually draw for each tab right now: the dot's colour class and its
// state attribute, so a purple dot can be matched to the state that produced it.
(async () => {
  const dots = [...document.querySelectorAll("[data-agent-dot]")];
  if (dots.length === 0) {
    // Fall back to the tab chips: read every state attribute the strip exposes.
    const chips = [...document.querySelectorAll("[data-tab-id]")].map((chip) => ({
      tabId: chip.getAttribute("data-tab-id"),
      text: chip.textContent.replace(/\s+/g, " ").trim().slice(0, 40),
      attrs: [...chip.attributes]
        .filter((a) => a.name.startsWith("data-"))
        .map((a) => `${a.name}=${a.value}`),
      dotClass: chip.querySelector("[data-agent-dot], [class*='rounded-full']")?.className ?? null,
    }));
    return { dots: 0, chips };
  }
  return {
    dots: dots.length,
    items: dots.map((d) => ({
      state: d.getAttribute("data-agent-dot"),
      title: d.getAttribute("title"),
      className: d.className,
      colour: getComputedStyle(d).backgroundColor,
    })),
  };
})();
