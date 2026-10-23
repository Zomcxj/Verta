// List the items in the current menu with their on-screen coordinates, so cdp-key.mjs can open one with real
// mouse events.
(async () => {
  const rect = (node) => {
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  };
  const trigger = document.querySelector(
    "button[title='新标签页'], button[title='New tab'], button[title$='标签页']",
  );
  return JSON.stringify(
    {
      trigger: trigger ? rect(trigger) : null,
      items: [...document.querySelectorAll("[role='menuitem']")].map((node) => ({
        text: node.textContent?.trim(),
        ...rect(node),
      })),
    },
    null,
    2,
  );
})();