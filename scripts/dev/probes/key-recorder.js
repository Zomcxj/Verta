// Key recorder: install once, then every call returns "which keydowns arrived since the previous call".
// Used to tell whether real keys sent over CDP actually reach the page (and who preventDefault'd them).
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
      // Log during the capture phase: the app's own handlers may stopImmediatePropagation there, so binding
      // on the bubble phase would miss exactly the keys the app swallows.
      true,
    );
  }
  const seen = window.__keyLog;
  window.__keyLog = [];
  return { delivered: seen };
})();