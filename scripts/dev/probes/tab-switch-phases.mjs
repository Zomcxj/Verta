// Where does the click's 2.5 s go? Records a CPU profile around the switch and reports the
// heaviest self-time functions, so the fix targets the real work rather than a guess.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const startProfiling = window.__vertaProfilerStart;
  const stopProfiling = window.__vertaProfilerStop;
  // Use CDP's profiler if the harness exposed it; otherwise report what we can from marks.
  const chips = () => [...document.querySelectorAll("[data-tab-id]")];
  const other = chips().find((c) => c.getAttribute("data-tab-active") !== "true");

  // Time each phase in the click handler by wrapping the visible parts we can observe.
  const marks = [];
  const mark = (name) => marks.push({ name, t: Math.round(performance.now()) });

  const t0 = performance.now();
  mark("before-click");
  const r = other.getBoundingClientRect();
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    other.dispatchEvent(
      new MouseEvent(type, { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }),
    );
  }
  other.click();
  mark("after-click-dispatch");
  // A macrotask boundary shows whether the synchronous handler already blocked.
  await new Promise((resolve) => setTimeout(resolve, 0));
  mark("after-macrotask");
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  mark("after-frame");
  await wait(3000);
  mark("after-settle");

  const phases = [];
  for (let i = 1; i < marks.length; i += 1) {
    phases.push({ phase: `${marks[i - 1].name} -> ${marks[i].name}`, ms: marks[i].t - marks[i - 1].t });
  }
  return {
    tabs: chips().map((c) => c.textContent.replace(/\s+/g, " ").trim().slice(0, 20)),
    totalMs: Math.round(performance.now() - t0),
    phases,
    // How many SCM rows and terminal panes are mounted, since either can dominate a render.
    domNodes: document.querySelectorAll("*").length,
    scmRows: document.querySelectorAll("[data-scm-row]").length,
    terminals: document.querySelectorAll("canvas, [data-pty-id]").length,
  };
})();
