// 连续采样文件树区域一段时间的纯采样器（不点击）。供 click-watch.mjs 与手工并行使用。
// 采样期间页面保持可交互，所以别再用第二个 CDP 客户端点击：WebView2 只服务一个调试客户端。
(async () => {
  const ERROR = /找不到|指定的路径无效|os error|无法|不存在/;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const rootOf = () =>
    [...document.querySelectorAll("[title]")]
      .map((node) => node.getAttribute("title"))
      .find((t) => t && t !== "显示/隐藏侧栏" && /[/\\]/.test(t)) ?? null;

  const samples = [];
  const started = Date.now();
  while (Date.now() - started < 20000) {
    const bad = document.body.innerText
      .split("\n")
      .filter((line) => ERROR.test(line))
      .slice(0, 2);
    samples.push({
      ms: Date.now() - started,
      root: rootOf(),
      tabs: document.querySelectorAll("[role='tab']").length,
      bad: bad.length ? bad : null,
    });
    await sleep(100);
  }

  const withBad = samples.filter((s) => s.bad);
  const trail = samples.filter(
    (s, i) =>
      s.bad ||
      (i > 0 && (s.root !== samples[i - 1].root || s.tabs !== samples[i - 1].tabs)) ||
      i === 0 ||
      i === samples.length - 1,
  );
  return JSON.stringify(
    { 样本数: samples.length, 出错样本次数: withBad.length, 前几个出错样本: withBad.slice(0, 3), 轨迹: trail },
    null,
    2,
  );
})();