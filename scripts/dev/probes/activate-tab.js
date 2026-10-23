// Activate a tab by title (clicking the real tab element). Used to verify things like "is the content of a given
// tab transparent".
// The title goes in NAME below; the id of the tab that ends up active is reported so it can be clicked back.
(async () => {
  const NAME = "README.md";
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const tabs = [...document.querySelectorAll("[data-tab-id]")];
  const before = tabs.find((el) => el.getAttribute("data-tab-active") === "true");
  const target = tabs.find((el) => (el.textContent || "").includes(NAME));
  if (!target) {
    return {
      clicked: false,
      seen: tabs.map((el) => (el.textContent || "").replace(/\s+/g, " ").trim()),
    };
  }
  // Tabs are Radix tab triggers: they react to mousedown, so a bare click will not switch them.
  target.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
  );
  target.click();
  await wait(600);
  const after = [...document.querySelectorAll("[data-tab-id]")].find(
    (el) => el.getAttribute("data-tab-active") === "true",
  );
  return {
    clicked: true,
    before: before?.getAttribute("data-tab-id") ?? null,
    after: after?.getAttribute("data-tab-id") ?? null,
  };
})();