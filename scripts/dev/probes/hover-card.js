// Read the text inside the hover popover (a Radix hover card): find it by its copy, not by internal attribute names.
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