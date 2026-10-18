(() => {
  const button = document.querySelector("button[title='远程仓库']");
  if (!button) return JSON.stringify({ clicked: false });
  button.click();
  return JSON.stringify({ clicked: true });
})();
