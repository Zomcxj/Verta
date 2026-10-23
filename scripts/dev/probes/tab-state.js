// Current tab state plus whether focus is inside a terminal. Used for acceptance like "did that key press really
// close the terminal tab":
// the focus has to be confirmed to be in the terminal first, or the key press proves nothing.
(() => {
  const tabs = [...document.querySelectorAll("[data-tab-id]")].map((el) => ({
    id: el.getAttribute("data-tab-id"),
    active: el.getAttribute("data-tab-active") === "true",
    title: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
  }));
  const active = document.activeElement;
  const describe = (el) => {
    if (!el) return null;
    const attrs = [...el.attributes]
      .filter((a) => a.name.startsWith("data-") || a.name === "aria-label")
      .map((a) => `${a.name}=${a.value}`)
      .slice(0, 4);
    return {
      tag: el.tagName.toLowerCase(),
      cls: (el.className || "").toString().split(/\s+/).slice(0, 3).join(" "),
      attrs,
    };
  };
  const inTerminal = Boolean(
    active?.closest?.("[data-verta-terminal-surface], [data-terminal-area]"),
  );
  return {
    count: tabs.length,
    activeId: tabs.find((t) => t.active)?.id ?? null,
    terminalTabs: tabs.filter((t) => /终端|Terminal|shell|pwsh|PowerShell/i.test(t.title)).length,
    focusInTerminal: inTerminal,
    activeElement: describe(active),
    tabs,
  };
})();
