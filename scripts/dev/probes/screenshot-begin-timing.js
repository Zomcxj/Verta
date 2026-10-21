// 区域截图验收：在主窗口里量一次 `screenshot_begin` 要多久。
//
// 这一步现在只做「把覆盖窗口亮出来」：不抓屏、不落盘、不换图，所以它就是「点一下到灰层上来」的
// 上界。冷启动（第一次要建 webview）和热启动（窗口养着）差多少，一眼能看出来。
(async () => {
  const started = performance.now();
  await window.__TAURI_INTERNALS__.invoke("screenshot_begin");
  return { ms: Math.round(performance.now() - started) };
})();