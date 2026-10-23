// Find the elements that are both opaque and big enough on screen - under a glass theme these are the layers
// covering the desktop. A computed value starting with `rgb(` is opaque; anything with alpha (`rgba(`,
// `oklab(... / 0.34)`) does not count.
//
// `visibility: hidden` is not filtered out: the editor/terminal tabs are stacked as `absolute inset-0` and
// the inactive ones are marked `invisible`, but **they are still in the DOM**. Filtering them would leave
// only the active tab measurable, and whoever measures usually does not want to disturb the tab the user is
// looking at.
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