// 按键记录器：装一次，之后每次调用都返回「自上次以来收到过哪些 keydown」。
// 用来判断 CDP 发的真按键到底有没有到页面（以及被谁 preventDefault 了）。
(() => {
  if (!window.__keyLog) {
    window.__keyLog = [];
    window.addEventListener(
      "keydown",
      (e) => {
        const target = e.target;
        window.__keyLog.push({
          key: e.key,
          code: e.code,
          ctrl: e.ctrlKey,
          shift: e.shiftKey,
          alt: e.altKey,
          meta: e.metaKey,
          prevented: e.defaultPrevented,
          target: `${target?.tagName ?? "?"}.${((target?.className ?? "").toString().split(/\s+/)[0] ?? "")}`,
        });
      },
      // 捕获阶段先记一笔：应用自己的处理在捕获阶段就可能 stopImmediatePropagation，
      // 挂在冒泡阶段会漏掉「被应用吃掉」的那些键。
      true,
    );
  }
  const seen = window.__keyLog;
  window.__keyLog = [];
  return { delivered: seen };
})();