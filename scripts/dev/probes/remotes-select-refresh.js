(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tabs = [...document.querySelectorAll("[role='tab'], button[data-tab-title], button")];
  const tab = tabs.find((n) => n.textContent.trim() === "远程仓库" && n.getBoundingClientRect().top < 60);
  if (!tab) return JSON.stringify({ tab: false });
  tab.click();
  await sleep(1500);
  const input = document.querySelector("input[placeholder='筛选仓库']");
  if (!input) return JSON.stringify({ tab: true, input: false, body: document.body.innerText.slice(0, 200) });
  const button = input.parentElement.querySelector("button");
  button.click();
  return JSON.stringify({ tab: true, refresh: button.innerText.trim() });
})();
