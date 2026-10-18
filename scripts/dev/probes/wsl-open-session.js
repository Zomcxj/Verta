// 验收 R13：点开一条 WSL 会话，确认它开在 WSL 终端里并在该会话的 Linux 目录恢复。
// 终端正文画在 canvas 上读不到，所以这里只回标签与窗口标题；真正落在哪个环境看 dev 日志的
// `pty cwd:` 与 `spawning ... shell` 两行。
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clickByText = (label) => {
    const node = [...document.querySelectorAll("button")].find(
      (button) => button.textContent.trim() === label,
    );
    if (!node) return false;
    node.click();
    return true;
  };

  clickByText("会话");
  await sleep(2500);

  const wanted = "/home/cxj/workspace/mem0_chat_fastapi";
  const row = [...document.querySelectorAll("button")].find((button) =>
    (button.getAttribute("title") ?? "").includes(wanted),
  );
  if (!row) return JSON.stringify({ error: `没找到 cwd 为 ${wanted} 的会话行` });
  const rowTitle = row.getAttribute("title");

  row.click();
  await sleep(8000);

  return JSON.stringify(
    {
      rowTitle,
      tabStrip: document.body.innerText.split("\n").slice(0, 6),
      windowTitle: document.title,
    },
    null,
    2,
  );
})();