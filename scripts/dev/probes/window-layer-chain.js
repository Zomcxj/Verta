// 从某个元素往上走，把每一层的背景色报出来 —— 一眼看出是哪一层盖住了窗口材质。
// 默认从窗口里最靠上的那块容器开始；也可以传 --match=settings.html 看设置窗口。
(() => {
  const chains = [];
  const roots = [
    document.getElementById("root"),
    document.getElementById("settings-root"),
  ].filter(Boolean);
  for (const start of roots) {
    const chain = [];
    let node = start;
    while (node) {
      const style = getComputedStyle(node);
      chain.push({
        tag: node.tagName.toLowerCase(),
        id: node.id || null,
        cls: (node.className || "").toString().split(/\s+/).slice(0, 4).join(" "),
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage.slice(0, 60),
      });
      node = node.parentElement;
    }
    // 再补一层：窗口正中那个元素（面板 / 卡片）。
    const middle = document.elementFromPoint(
      window.innerWidth / 2,
      window.innerHeight / 2,
    );
    chains.push({ start: start.id, chain, middle: middle ? describe(middle) : null });
  }

  function describe(el) {
    const style = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      cls: (el.className || "").toString().split(/\s+/).slice(0, 4).join(" "),
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage.slice(0, 60),
    };
  }

  const root = document.documentElement;
  return {
    window: location.pathname,
    htmlBackground: getComputedStyle(root).backgroundColor,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    frame: getComputedStyle(root).getPropertyValue("--frame").trim(),
    chains,
  };
})();
