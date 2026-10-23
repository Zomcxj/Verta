// Region-screenshot acceptance (1/3): find the "screenshot" button in the top right of the **main window**.
//
// Hand back its centre coordinates (for cdp-input.mjs to click for real) and the devicePixelRatio (needed for
// physical pixel maths), plus the titles of the buttons in the same row to confirm it sits next to the Git panel
// button.
(() => {
  const wanted = ["截图", "Screenshot"];
  const buttons = [...document.querySelectorAll("button")];
  const button = buttons.find((b) => wanted.includes(b.getAttribute("title")));
  if (!button) {
    return {
      found: false,
      titles: buttons.map((b) => b.getAttribute("title")).filter(Boolean).slice(0, 20),
    };
  }
  const rect = button.getBoundingClientRect();
  return {
    found: true,
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    dpr: window.devicePixelRatio,
    row: [...(button.parentElement?.querySelectorAll("button") ?? [])]
      .map((b) => b.getAttribute("title"))
      .filter(Boolean),
  };
})();