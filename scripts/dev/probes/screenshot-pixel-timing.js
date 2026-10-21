// 区域截图验收：量一下「整屏像素走 IPC 拿过来 + 铺到画布上」要多久。
//
// 这是「咔嚓一下冻住」里除了抓屏之外全部的开销。旧路径是写十几 MB 预览文件再让 asset 协议读了
// 解码，这里量出来的就是那趟被省掉的钱。
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