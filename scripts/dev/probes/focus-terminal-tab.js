// 切到终端标签页（名字为 ok 的那个）。只用于验收。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const label = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const tabs = [...document.querySelectorAll("button")].filter((element) =>
    /^(ok|Verta Go|README\.md)$/.test(label(element)),
  );
  const terminal = tabs.find((element) => !label(element).includes(".md"));
  if (!terminal) return `没找到终端标签，候选：${tabs.map(label).join(" | ")}`;
  terminal.click();
  await sleep(1500);
  return `已切到标签 ${label(terminal)}`;
})();