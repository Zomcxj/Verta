(() => {
  const layers = [...document.querySelectorAll("div")].filter((n) => n.innerText && /远程仓库|仓库/.test(n.innerText));
  const innermost = layers[layers.length - 1];
  return JSON.stringify({ text: (innermost?.innerText ?? document.body.innerText).slice(0, 700) }, null, 2);
})();
