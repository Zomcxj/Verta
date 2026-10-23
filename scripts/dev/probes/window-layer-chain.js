// Walk up from an element and report each layer's background colour - so it is obvious which layer is covering the
// window material.
// By default it starts from the topmost container in the window; pass --match=settings.html to inspect the
// settings window instead.
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
    // Plus one more: whatever element sits at the centre of the window (a panel / card).
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
