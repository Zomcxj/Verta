// 找出「不透明、又占屏够大」的元素 —— 玻璃主题下这些就是盖住桌面的那几层。
// 计算值以 rgb( 开头 = 不透明；rgba( / oklab(… / 0.34) 这类带 alpha 的不算。
//
// 不过滤 `visibility: hidden`：编辑器/终端各标签是 `absolute inset-0` 叠在一起、
// 非活动的那几个标成 `invisible`，但**它们照样在 DOM 里**。滤掉就只能量当前活动标签，
// 而量的人往往不想动用户正在看的那个标签。
(() => {
  const total = window.innerWidth * window.innerHeight;
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.opacity === "0") continue;
    const bg = style.backgroundColor;
    if (!/^rgb\(/.test(bg)) continue;
    const rect = el.getBoundingClientRect();
    const area = Math.round(rect.width * rect.height);
    if (area < total * 0.02) continue;
    out.push({
      cls: (el.className || "").toString().split(/\s+/).slice(0, 5).join(" "),
      size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
      share: Math.round((area / total) * 100),
      hidden: !el.getClientRects().length || style.visibility === "hidden",
      bg,
    });
  }
  out.sort((a, b) => b.share - a.share);
  return { viewport: [window.innerWidth, window.innerHeight], opaqueLarge: out.slice(0, 14) };
})();