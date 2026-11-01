// Clicks the real upgrade button and waits for the confirmation, then reports both.
// This runs the component's own update command for real.
(async () => {
  const bell = document.querySelector("[data-agent-bell]");
  if (!bell) return { ok: false, why: "no bell" };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const full = (el) => {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
    el.click();
  };
  const text = () =>
    (
      document.querySelector("[data-radix-popper-content-wrapper]")?.textContent ?? ""
    )
      .replace(/\s+/g, " ")
      .trim();

  document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  await wait(400);
  full(bell);
  for (let i = 0; i < 20 && !document.querySelector("[data-agent-update] button"); i += 1) {
    await wait(500);
  }
  const button = document.querySelector("[data-agent-update] button");
  if (!button) return { ok: false, why: "no upgrade button", text: text() };

  const before = text();
  full(button);
  // The upgrade runs a real npm/pi command and then re-checks; allow it a while.
  let confirmation = null;
  for (let i = 0; i < 120; i += 1) {
    confirmation = document.querySelector("[data-agent-updated]");
    if (confirmation) break;
    await wait(500);
  }
  return {
    ok: true,
    before,
    confirmationText: confirmation ? confirmation.textContent.trim() : null,
    rowsLeft: [...document.querySelectorAll("[data-agent-update]")].map((r) =>
      r.getAttribute("data-agent-update"),
    ),
    after: text(),
  };
})();
