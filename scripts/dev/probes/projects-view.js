// 读项目列表标签页的现状：表格行、输入框、空态与报错。
(async () => {
  const text = (node) => node.innerText.trim().replace(/\s+/g, " ");
  const rows = [...document.querySelectorAll("table tbody tr")].map((tr) =>
    [...tr.querySelectorAll("td")].map((td) => text(td)).join(" | "),
  );
  const inputs = [...document.querySelectorAll("input")].map((input) => {
    const r = input.getBoundingClientRect();
    return {
      placeholder: input.placeholder,
      value: input.value,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
    };
  });
  const body = document.body.innerText;
  const start = body.indexOf("项目");
  return JSON.stringify(
    {
      行数: rows.length,
      行: rows.slice(0, 25),
      输入框: inputs,
      空态: body.includes("还没有项目"),
      片段: start >= 0 ? body.slice(start, start + 300) : null,
    },
    null,
    2,
  );
})();