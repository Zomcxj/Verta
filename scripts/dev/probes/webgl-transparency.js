// WebGL 回退路径的透明适配验收（没有 WebGPU 的机器走的就是这条路）：
// 画布上下文是否带 alpha、画布/面板/根元素的底色是否真的透明。
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // WebGPU 的窗口画布带 data-verta-terminal-canvas；WebGL 回退的画布没有这个属性
  // （构造函数只设了 class="block" 与 aria-hidden），所以两种都认。
  for (let i = 0; i < 80; i += 1) {
    if (
      document.querySelector("[data-verta-terminal-canvas]") ??
      document.querySelector('canvas.block[aria-hidden="true"]') ??
      document.querySelector("[data-pane-leaf] canvas")
    ) {
      break;
    }
    await sleep(250);
  }
  const canvas =
    document.querySelector("[data-verta-terminal-canvas]") ??
    document.querySelector('canvas.block[aria-hidden="true"]') ??
    document.querySelector("[data-pane-leaf] canvas");
  if (!canvas) {
    return JSON.stringify({
      ok: false,
      step: "页面上没有终端画布",
      提示: "可能走的是 WebGPU 路径，或终端面板还没渲染",
    });
  }
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  const attrs = gl?.getContextAttributes?.() ?? null;
  const bg = (node) => (node ? getComputedStyle(node).backgroundColor : null);
  const pane = canvas.closest("[data-pane-leaf]");
  const root = pane?.parentElement ?? null;
  return JSON.stringify(
    {
      ok: true,
      画布上下文: attrs ? { alpha: attrs.alpha, premultipliedAlpha: attrs.premultipliedAlpha } : null,
      画布CSS底色: bg(canvas),
      面板底线: bg(pane),
      根元素: root
        ? { 行内底色: root.style.backgroundColor, 计算底色: bg(root) }
        : null,
      终端底色变量: getComputedStyle(document.documentElement)
        .getPropertyValue("--terminal-background")
        .trim(),
      窗口透明: document.documentElement.dataset.vibrancy ?? null,
    },
    null,
    2,
  );
})();