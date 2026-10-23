// Region-screenshot acceptance: time "fetch the full-screen pixels over IPC + paint them onto the canvas".
//
// That is every cost of the frozen "click" frame except the screen grab itself. The old path wrote a preview
// file of a dozen MB and had the asset protocol read and decode it; what is measured here is the trip that was
// removed.
(async () => {
  const started = performance.now();
  const buffer = await window.__TAURI_INTERNALS__.invoke("screenshot_pixels");
  const fetched = performance.now();
  const canvas = document.querySelector("canvas");
  let painted = fetched;
  if (canvas) {
    canvas.getContext("2d")?.putImageData(
      new ImageData(new Uint8ClampedArray(buffer), canvas.width, canvas.height),
      0,
      0,
    );
    painted = performance.now();
  }
  return {
    ipcMs: Math.round(fetched - started),
    paintMs: Math.round(painted - fetched),
    bytes: buffer.byteLength,
    canvas: canvas ? { w: canvas.width, h: canvas.height } : null,
  };
})();