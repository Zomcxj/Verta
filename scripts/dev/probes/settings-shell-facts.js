// 设置窗口的纹理被哪一层压掉了：报出 shell / root / body 的矩形与底色，
// 并临时把 shell 变透明，好量出纹理原本的强度（这一步只改内存里的样式）。
(() => {
  const shell = document.querySelector(".settings-shell");
  const root = document.getElementById("settings-root");
  const info = (el) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      cls: (typeof el.className === "string" ? el.className : "").split(/\s+/).slice(0, 3).join(" "),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      bg: s.backgroundColor,
      bgImageLen: s.backgroundImage.length,
    };
  };
  const style = document.createElement("style");
  style.id = "probe-shell-off";
  style.textContent = ".settings-shell { background: transparent !important; }";
  document.head.appendChild(style);
  return {
    viewport: [window.innerWidth, window.innerHeight],
    root: info(root),
    shell: info(shell),
    shellParent: shell?.parentElement
      ? `${shell.parentElement.tagName.toLowerCase()}#${shell.parentElement.id}.${(typeof shell.parentElement.className === "string" ? shell.parentElement.className : "").split(/\s+/).slice(0, 2).join(".")}`
      : null,
    note: "已临时把 .settings-shell 置透明（probe-shell-off），截图量完可以刷新还原",
  };
})();