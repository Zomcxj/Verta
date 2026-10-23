// List the text and coordinates of the "project name" buttons in the project rows, so cdp-key.mjs can hover or
// click them.
(() =>
  JSON.stringify(
    [...document.querySelectorAll("table tbody tr button")].map((node) => {
      const r = node.getBoundingClientRect();
      return {
        name: node.textContent?.trim(),
        x: Math.round(r.left + Math.min(r.width, 220) / 2),
        y: Math.round(r.top + r.height / 2),
      };
    }),
    null,
    1,
  ))();