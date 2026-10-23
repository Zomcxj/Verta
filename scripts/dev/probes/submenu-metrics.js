// Acceptance for the popover width: read the submenu container's width and each item's height (a height beyond one
// line means it wrapped).
(async () => {
  const sub = document.querySelector("[data-slot='dropdown-menu-sub-content']");
  const rect = (node) => {
    const r = node.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  };
  if (!sub) return JSON.stringify({ submenu: null });
  return JSON.stringify(
    {
      submenu: rect(sub),
      items: [...sub.querySelectorAll("[role='menuitem']")].map((node) => ({
        text: node.textContent?.trim(),
        ...rect(node),
      })),
    },
    null,
    2,
  );
})();