// Opens the header bell and reports what the popover actually shows.
(async () => {
  const bell = document.querySelector("[data-agent-bell]");
  if (!bell) return { ok: false, why: "no [data-agent-bell] in the header" };
  const rect = bell.getBoundingClientRect();
  const badge = bell.querySelector("[data-agent-bell-count]");
  const header = bell.parentElement;
  const github = header?.querySelector("[data-github], [title*='GitHub'], a[href*='github']");
  const bellLeft = Math.round(rect.left);
  const githubLeft = github ? Math.round(github.getBoundingClientRect().left) : null;
  // Open it the way a click would, then read the popover once it has rendered.
  bell.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  bell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  bell.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
  bell.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  bell.click();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(4000);
  const popover = document.querySelector("[role='menu'], [data-radix-popper-content-wrapper]");
  const rows = [...document.querySelectorAll("[data-agent-update]")].map((row) => ({
    id: row.getAttribute("data-agent-update"),
    text: row.textContent.replace(/\s+/g, " ").trim(),
  }));
  return {
    ok: true,
    bellVisible: rect.width > 0 && rect.height > 0,
    bellLeft,
    githubLeft,
    bellIsLeftOfGithub: githubLeft === null ? null : bellLeft < githubLeft,
    badge: badge ? badge.textContent.trim() : null,
    popoverOpen: Boolean(popover),
    updateRows: rows,
    popoverText: popover ? popover.textContent.replace(/\s+/g, " ").trim() : null,
  };
})();
