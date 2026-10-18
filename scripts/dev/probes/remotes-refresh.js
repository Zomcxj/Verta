(() => {
  const input = document.querySelector("input[placeholder='筛选仓库']");
  const button = input?.parentElement?.querySelector("button");
  if (!button) return JSON.stringify({ clicked: false });
  button.click();
  return JSON.stringify({ clicked: true, label: button.innerText.trim() });
})();
