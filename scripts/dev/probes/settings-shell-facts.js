// Which layer covers up the settings window's texture: report the rect and background colour of shell / root /
// body, and temporarily make the shell transparent to measure the texture's original strength (this step only
// touches in-memory styles).
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
    note: ".settings-shell was temporarily made transparent (probe-shell-off); refresh to restore it after measuring",
  };
})();