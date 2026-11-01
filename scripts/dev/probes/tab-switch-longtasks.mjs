// Detect long main-thread blocks around a tab switch. A "frozen UI" shows up as long tasks:
// the browser cannot paint or respond to input while one runs, which is exactly the symptom.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const longTasks = [];
  let observer = null;
  if (typeof PerformanceObserver !== "undefined") {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push({ start: Math.round(entry.startTime), dur: Math.round(entry.duration) });
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      observer = null;
    }
  }

  const chips = () => [...document.querySelectorAll("[data-tab-id]")];
  const titles = () => chips().map((c) => c.textContent.replace(/\s+/g, " ").trim().slice(0, 20));
  if (chips().length < 2) {
    return { why: "fewer than two tabs", titles: titles() };
  }
  const other = chips().find((c) => c.getAttribute("data-tab-active") !== "true");

  // A click dispatched from here still runs the same React work; what is measured is that work.
  const startMark = performance.now();
  const r = other.getBoundingClientRect();
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    other.dispatchEvent(
      new MouseEvent(type, { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }),
    );
  }
  other.click();

  // Let React finish; measure how long until a frame actually paints afterwards.
  const t0 = performance.now();
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const firstFrame = Math.round(performance.now() - t0);
  await wait(2500);
  observer?.disconnect();
  return {
    tabs: titles(),
    firstFrameAfterClickMs: firstFrame,
    longTasksDuringSwitch: longTasks.filter((t) => t.start >= startMark - 50),
    totalLongTaskMs: longTasks.reduce((sum, t) => sum + t.dur, 0),
  };
})();
