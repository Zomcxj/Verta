// 区域截图验收：在**覆盖窗口**里一口气把「框选 → 挪动 → 拉把手」做完，并报出每一步的选区。
//
// 为什么整段跑在一次 evaluate 里：dev 期间另一个会话改文件会触发 HMR 整页重载，跨命令的鼠标
// 输入会被打断（CDP 的 Input.dispatchMouseEvent 会直接超时）。整段在一个 JavaScript 里跑完，
// 中间插不进重载。合成 PointerEvent 能顶用，是因为覆盖窗口的手势挂在 window 上、不用指针捕获。
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const box = () => document.querySelector('[data-screenshot-ui="box"]');
  const backdrop = () => document.querySelector('[data-screenshot-ui="backdrop"]');
  const rect = () => {
    const el = box();
    if (!el) return null;
    const style = el.style;
    return {
      x: Math.round(parseFloat(style.left)),
      y: Math.round(parseFloat(style.top)),
      w: Math.round(parseFloat(style.width)),
      h: Math.round(parseFloat(style.height)),
    };
  };
  const fire = (target, type, x, y, buttons) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons,
        pointerId: 3,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );

  const out = { start: rect() };

  // 1) 框一块：400,300 → 1000,700
  fire(backdrop(), "pointerdown", 400, 300, 1);
  await sleep(30);
  fire(window, "pointermove", 1000, 700, 1);
  await sleep(60);
  out.dragLive = rect();
  fire(window, "pointerup", 1000, 700, 0);
  await sleep(60);
  out.dragDone = rect();
  out.handles = document.querySelectorAll('[aria-label^="调整"]').length;
  out.buttons = [...document.querySelectorAll("button")]
    .map((b) => b.getAttribute("aria-label") || (b.innerText || "").trim())
    .filter(Boolean);

  // 2) 拖整块：+60,+40
  fire(box(), "pointerdown", 700, 500, 1);
  await sleep(30);
  fire(window, "pointermove", 760, 540, 1);
  await sleep(60);
  out.movedLive = rect();
  fire(window, "pointerup", 760, 540, 0);
  await sleep(60);
  out.moved = rect();

  // 3) 拉右下角把手：+100,+100
  const before = rect();
  fire(
    document.querySelector('[aria-label="调整 se"]'),
    "pointerdown",
    before.x + before.w,
    before.y + before.h,
    1,
  );
  await sleep(30);
  fire(window, "pointermove", before.x + before.w + 100, before.y + before.h + 100, 1);
  await sleep(60);
  out.resizedLive = rect();
  fire(window, "pointerup", before.x + before.w + 100, before.y + before.h + 100, 0);
  await sleep(60);
  out.resized = rect();

  out.texts = (document.body.innerText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  out.previewSrc = (document.querySelector("img")?.getAttribute("src") || "").slice(-40);
  out.imgNatural = (() => {
    const img = document.querySelector("img");
    return img ? { w: img.naturalWidth, h: img.naturalHeight } : null;
  })();
  return out;
})();