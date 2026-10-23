// Region-screenshot acceptance (2/3): report the current look of the **overlay window**.
//
// Three things must be visible: whether the full-screen image fills at 1/dpr (one pixel per pixel), the current
// selection and handles, and which buttons the action bar carries.
(() => {
  const img = document.querySelector("img");
  const imgRect = img?.getBoundingClientRect();
  // The marker for the selection block: an oversized box-shadow dims everything outside the box.
  const selection = [...document.querySelectorAll("div")].find((d) =>
    (d.style.boxShadow || "").includes("100vmax"),
  );
  const style = selection?.style;
  return {
    dpr: window.devicePixelRatio,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    img: imgRect
      ? {
          left: Math.round(imgRect.left),
          top: Math.round(imgRect.top),
          w: Math.round(imgRect.width),
          h: Math.round(imgRect.height),
          naturalW: img.naturalWidth,
          naturalH: img.naturalHeight,
        }
      : null,
    selection: style
      ? {
          x: Math.round(parseFloat(style.left)),
          y: Math.round(parseFloat(style.top)),
          w: Math.round(parseFloat(style.width)),
          h: Math.round(parseFloat(style.height)),
        }
      : null,
    handles: [...document.querySelectorAll("[aria-label^='调整']")].map((h) => h.getAttribute("aria-label")),
    buttons: [...document.querySelectorAll("button")]
      .map((b) => (b.innerText || "").trim())
      .filter(Boolean),
    texts: (document.body.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean),
  };
})();