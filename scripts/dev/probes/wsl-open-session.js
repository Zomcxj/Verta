// Acceptance R13: open a WSL session and confirm it opens in a WSL terminal and resumes in that session's Linux
// directory.
// Terminal output is painted onto a canvas and cannot be read, so only the tab and window titles come back here;
// which environment it really landed in shows up in the dev log's `pty cwd:` and `spawning ... shell` lines.
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