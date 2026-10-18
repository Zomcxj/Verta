// 验收 R13：切到「会话」视图，读回面板里的分组标题与会话行（Windows / WSL 并存）。
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

  const clicked = clickByText("会话");
  // 本机是秒回，发行版要起 wsl.exe 跑 python3，实测 0.5 秒左右，多等一点。
  await sleep(2500);

  // 面板的空状态/分组标题都在文本里，直接读整页文本最省事（占位符读不到 textContent）。
  const input = document.querySelector('input[placeholder="搜索标题或目录"]');
  return JSON.stringify(
    {
      clicked,
      hasSessionsInput: !!input,
      text: document.body.innerText.slice(0, 1600),
    },
    null,
    2,
  );
})();