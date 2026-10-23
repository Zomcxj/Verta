// Region-screenshot acceptance: press Esc once in the overlay window (a synthesized KeyboardEvent is enough -
// the cancel logic is bound on window).
(() => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  return "esc 已发";
})();