// 远程仓库标签页验收：头部按钮、标签页、表格行数与前几行内容、四态文案。
(() => {
  const rectOf = (node) => {
    const r = node.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width),
    };
  };
  const headerButtons = [...document.querySelectorAll("button[title]")]
    .filter((node) => {
      const r = node.getBoundingClientRect();
      return r.top < 60 && r.width > 0;
    })
    .map((node) => ({ title: node.title, ...rectOf(node) }));
  const rows = [...document.querySelectorAll("table tbody tr")].map((tr) =>
    [...tr.querySelectorAll("td")].map((td) => td.innerText.trim()),
  );
  const text = document.body.innerText;
  return JSON.stringify(
    {
      headerButtons,
      tabTitles: [...document.querySelectorAll("[role='tab'], button[data-tab-title]")]
        .map((n) => n.innerText.trim())
        .filter(Boolean),
      rowCount: rows.length,
      firstRows: rows.slice(0, 5),
      notice: {
        notInstalled: text.includes("没找到 gh"),
        notLoggedIn: text.includes("gh 还没登录"),
        empty: text.includes("这个账号下没有仓库"),
        failed: text.includes("读取远程仓库失败"),
        filtered: text.includes("没有匹配"),
      },
      count: (text.match(/\d+ \/ \d+ 个仓库/) ?? [])[0] ?? null,
      account: (text.match(/已登录 [^\s]+/) ?? [])[0] ?? null,
      truncated: text.includes("还有更多仓库"),
    },
    null,
    2,
  );
})();