// Region-screenshot acceptance (4/4): **wait** for the screenshot toast in the main window, click its "insert
// path", and report what was seen.
//
// Why wait: the toast disappears after 4 seconds by default, so asking afterwards usually finds it gone (been
// there). This probe installs a poll first, something outside triggers the screenshot, and only once the toast
// really shows up does it read and click it.
(async () => {
  const deadline = Date.now() + 60_000;
  let toast = null;
  while (Date.now() < deadline) {
    toast = document.querySelector("[data-sonner-toast]");
    if (toast) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!toast) return { toast: null, why: "25 秒内没等到提示条" };

  const texts = [...document.querySelectorAll("[data-sonner-toast]")].map((t) =>
    (t.innerText || "").replace(/\n/g, " | "),
  );
  const action = toast.querySelector("button");
  if (!action) return { toast: texts, action: null, why: "提示条里没有按钮" };
  const rect = action.getBoundingClientRect();
  const label = (action.innerText || "").trim();
  action.click();
  await new Promise((r) => setTimeout(r, 600));
  return {
    toast: texts,
    action: {
      label,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      clicked: true,
    },
  };
})();