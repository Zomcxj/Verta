// List the tabs with their on-screen coordinates, so cdp-key.mjs can click the n-th one (to verify environment
// following).
(async () => {
  const rect = (node) => {
    const r = node.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
    };
  };
  const tabs = [...document.querySelectorAll("[role='tab']")].map((node, i) => ({
    i,
    text: node.textContent?.trim(),
    active: node.getAttribute("aria-selected") === "true",
    ...rect(node),
  }));
  return JSON.stringify({ tabs }, null, 2);
})();