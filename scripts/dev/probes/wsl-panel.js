// Acceptance R13: switch to the Sessions view and read back the group headings and session rows in the panel
// (Windows and WSL side by side).
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
  // Local sessions answer instantly; a distro has to start wsl.exe and run python3, which measures around 0.5s, so
  // wait a bit longer.
  await sleep(2500);

  // The panel's empty state and group headings are all in the text, so reading the whole page text is easiest
  // (placeholders are not in textContent).
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