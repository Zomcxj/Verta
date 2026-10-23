// Region-screenshot acceptance: do "marquee select → move → pull a handle" all at once inside the **overlay
// window** and report the selection rect at each step.
//
// Why run the whole thing in one evaluate: during dev, another session touching files triggers an HMR page
// reload, which interrupts mouse input across commands (CDP's Input.dispatchMouseEvent simply times out).
// One self-contained piece of JavaScript leaves no gap for a reload to slip in. Synthesized PointerEvents
// suffice here because the overlay's gestures are bound on `window` and need no pointer capture.
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

  // 1) Marquee a box: 400,300 → 1000,700
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

  // 2) Drag the whole box: +60,+40
  fire(box(), "pointerdown", 700, 500, 1);
  await sleep(30);
  fire(window, "pointermove", 760, 540, 1);
  await sleep(60);
  out.movedLive = rect();
  fire(window, "pointerup", 760, 540, 0);
  await sleep(60);
  out.moved = rect();

  // 3) Pull the bottom-right handle: +100,+100
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