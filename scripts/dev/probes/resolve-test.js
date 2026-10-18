(async () => {
  // 直接验证解析函数的输入假设：streamdown 传进来的 src 是否已经丢了 "./"
  const spans = [...document.querySelectorAll("span")].filter((s) =>
    (s.textContent ?? "").includes("not found"),
  );
  return spans.map((s) => `title=${s.getAttribute("title")}`).join("\n");
})();
