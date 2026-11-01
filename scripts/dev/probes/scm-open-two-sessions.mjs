// Opens two sessions from the list (different repositories), so a cold tab switch can be timed.
// Two separate evaluations would be needed if the click changed the page; this one waits, so it
// returns only after both are open and the tab strip has them.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const openSession = async (id) => {
    const tab = [...document.querySelectorAll("button")].find((b) =>
      /会话/.test(b.textContent ?? ""),
    );
    if (tab) {
      for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
        tab.dispatchEvent(new MouseEvent(t, { bubbles: true }));
      }
      tab.click();
    }
    await wait(1500);
    const row = document.querySelector(`[data-session-id='${id}']`);
    if (!row) return false;
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      row.dispatchEvent(new MouseEvent(t, { bubbles: true }));
    }
    row.click();
    return true;
  };
  const a = await openSession("ses_eb610ca76ffe14KYY7tfJVnEPr");
  await wait(4000);
  const b = await openSession("ses_0b91836bcffeMXu8HhMEBWgWU9");
  await wait(4000);
  return {
    opened: { verta: a, memopaws: b },
    tabs: [...document.querySelectorAll("[data-tab-id]")].map((t) => ({
      id: t.getAttribute("data-tab-id"),
      title: t.textContent.replace(/\s+/g, " ").trim().slice(0, 24),
      active: t.getAttribute("data-tab-active") === "true",
    })),
  };
})();
