// Pick a theme by name in the settings page: switch to the Themes section first (Radix tabs react to mousedown,
// so a bare click will not switch them), then click the real theme card. The name goes in NAME below.
(async () => {
  const NAME = "Acrylic";
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const buttons = () => [...document.querySelectorAll("button")];

  const hasCards = () => buttons().some((b) => (b.textContent || "").includes(NAME));
  if (!hasCards()) {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const nav = tabs.find((tab) => (tab.textContent || "").trim() === "主题");
    if (!nav) {
      return {
        clicked: false,
        reason: "没找到「主题」页签",
        tabs: tabs.map((t) => (t.textContent || "").trim()),
      };
    }
    nav.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
    );
    await wait(500);
  }

  const cards = buttons().filter((b) => (b.textContent || "").includes(NAME));
  if (cards.length === 0) {
    return { clicked: false, reason: "没找到主题卡片", sample: buttons().length };
  }
  const card = cards[cards.length - 1];
  card.click();
  await wait(600);
  return {
    clicked: true,
    text: (card.textContent || "").trim().slice(0, 40),
    storedThemeId: localStorage.getItem("verta-ui-theme-id-shadow"),
  };
})();
