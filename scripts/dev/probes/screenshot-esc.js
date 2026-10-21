// 区域截图验收：在覆盖窗口里按一次 Esc（合成 KeyboardEvent 就够——取消的逻辑挂在 window 上）。
(() => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  return "esc 已发";
})();