// What the SCM rows actually show now: counts, the status letter, and whether an untracked file
// has numbers. Reads the panel's DOM, so it reports the rendered result rather than the source.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // The panel may be closed; open it through the header's Git panel button.
  const opener = [...document.querySelectorAll("button")].find((b) =>
    /显示\/隐藏 Git 面板|Git panel/i.test(b.getAttribute("title") ?? ""),
  );
  if (opener) {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      opener.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
    opener.click();
  }
  await wait(1200);
  // Give the status refresh a moment to land with its counts. The panel renders its rows after
  // the snapshot arrives, so waiting for the first row is the reliable signal.
  let rows = [];
  for (let i = 0; i < 40; i += 1) {
    rows = [...document.querySelectorAll("[data-scm-row]")];
    if (rows.length > 0) break;
    await wait(500);
  }
  return {
    rowCount: rows.length,
    rows: rows.slice(0, 25).map((row) => ({
      path: row.getAttribute("data-scm-path"),
      counts: row.querySelector("[data-scm-counts]")?.textContent?.trim() ?? null,
      letter: row.querySelector("[data-scm-status]")?.textContent?.trim() ?? null,
      letterTitle: row.querySelector("[data-scm-status]")?.getAttribute("title") ?? null,
    })),
  };
})();
