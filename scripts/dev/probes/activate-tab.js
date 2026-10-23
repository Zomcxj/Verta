// 按标题激活一个标签（点的是真实标签元素）。用于验收「某个标签里的东西是不是透明」这类事。
// 标题写在下面的 NAME 里；点完把当时活动的标签 id 一起回报，方便点回去。
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
  // 标签是 Radix 的页签触发器：它认 mousedown，光 click 切不过去。
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