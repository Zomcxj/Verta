// 区域截图验收（4/4）：在主窗口里**等**截图提示条出现，点它的「插入路径」，报告看到了什么。
//
// 为什么要等：提示条默认 4 秒就消失，事后再问往往已经没了（我踩过）。这个探针先挂上轮询，
// 由外面去触发截图，等提示条真出现了再读它、点它。
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