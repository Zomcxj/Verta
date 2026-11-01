// Open a real session and report where the cover lifted.
// A tightened cover that never lifts would show up as a missing exit or `hard-cap`.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__vertaOpenTrace = [];
  const row =
    document.querySelector("[data-session-id='01a147ad-023f-71ff-b404-bb337dea4b63']") ??
    document.querySelector("[data-session-id]");
  if (!row) return { ok: false, why: "no session row" };
  const clicked = row.getAttribute("data-session-id");
  const title = row.textContent.replace(/\s+/g, " ").trim().slice(0, 40);
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    row.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  }
  row.click();

  const started = Date.now();
  await wait(20000);
  const trace = window.__vertaOpenTrace ?? [];
  const exits = trace.filter((e) => e.exit);
  const ticks = trace.filter((e) => e.t !== undefined && !e.exit && !e.heldBy);
  return {
    ok: true,
    clicked,
    title,
    exit: exits[exits.length - 1] ?? null,
    elapsedMs: Date.now() - started,
    tickCount: ticks.length,
    heldByRule: trace.filter((e) => e.heldBy).length,
    stalledAtHardCap: exits.some((e) => e.exit === "hard-cap"),
    // The screen at the moment the cover lifted: it must not be the launch command.
    lastScreen: (ticks[ticks.length - 1]?.screenTail ?? "").slice(-100),
  };
})();
