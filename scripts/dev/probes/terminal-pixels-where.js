// Where do the terminal's pixels actually live?
//
// The transition layer hides the terminal by setting `opacity: 0` on the tab's own
// container. If the renderer draws into a canvas that is NOT inside that container,
// then nothing about the terminal is hidden while the layer is up. This prints the
// shape of the terminal stack and the position of every canvas in it, plus the
// computed opacity of each container right now.
(async () => {
  const stack = document.querySelector("[data-terminal-stack]");
  const describe = (el, depth = 0) => {
    const out = [];
    for (const child of el.children) {
      const style = getComputedStyle(child);
      out.push({
        depth,
        tag: child.tagName,
        data: [...child.attributes]
          .map((a) => a.name)
          .filter((n) => n.startsWith("data-"))
          .join(","),
        opacity: style.opacity,
        visibility: style.visibility,
        isCanvas: child.tagName === "CANVAS",
        width: child.tagName === "CANVAS" ? child.width : undefined,
        height: child.tagName === "CANVAS" ? child.height : undefined,
      });
      if (depth < 3 && child.childElementCount > 0) out.push(...describe(child, depth + 1));
    }
    return out;
  };
  const canvases = [...document.querySelectorAll("canvas")].map((c) => {
    const rect = c.getBoundingClientRect();
    return {
      inTab: !!c.closest("[data-terminal-tab]"),
      inArea: !!c.closest("[data-terminal-area]"),
      parentData: c.parentElement?.getAttribute("data-terminal-area") !== null ? "area" : (c.parentElement?.className || "").toString().slice(0, 40),
      size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
      px: `${c.width}x${c.height}`,
      opacity: getComputedStyle(c).opacity,
    };
  });
  return JSON.stringify(
    {
      stackTree: stack ? describe(stack) : null,
      canvases,
      areaOpacity: (() => {
        const area = document.querySelector("[data-terminal-area]");
        return area ? getComputedStyle(area).opacity : "no-area";
      })(),
      tabOpacity: [...document.querySelectorAll("[data-terminal-tab]")].map((n) => ({
        tab: n.getAttribute("data-terminal-tab"),
        opacity: getComputedStyle(n).opacity,
        visibility: getComputedStyle(n).visibility,
      })),
      renderer: [...document.querySelectorAll("[data-terminal-tab]")].map((n) =>
        n.querySelector("[data-terminal-surface], [data-renderer]")?.getAttribute("data-renderer") ?? null,
      ),
      overlayPresent: !!document.querySelector("[data-session-opening]"),
    },
    null,
    1,
  );
})();