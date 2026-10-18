// 读悬停浮层（Radix hover card）里的文本：按文案找，别依赖内部属性名。
(() => {
  const MARKER = "这个项目的会话";
  const node = [...document.querySelectorAll("div")].find(
    (candidate) =>
      candidate.innerText?.includes(MARKER) &&
      candidate.innerText.length < 1200 &&
      candidate.querySelector("button"),
  );
  return JSON.stringify(
    { found: Boolean(node), text: node?.innerText ?? null },
    null,
    2,
  );
})();