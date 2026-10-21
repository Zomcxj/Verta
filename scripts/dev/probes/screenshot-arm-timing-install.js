// 区域截图验收：在覆盖窗口里挂上「收到消息 → 画面真的出现在屏幕上一帧」的计时。
//
// 用户对这件事的原始抱怨是「打开要弹一下」。现在不冻屏，也就没有「等图」这一段；要证的是：
// 后端把窗口亮出来的那一刻起，覆盖窗口自己有没有拖后腿（理想是一帧内就画上）。
//
// 为什么分成「挂载」与「读取」两个探针：先挂上（此时窗口可能还藏在后台，`rAF` 也不一定在跑），
// 再从主窗口触发一次截图，最后回来读数字。
//
// 探针是裸脚本，import 不了 `@tauri-apps/api`，所以按那个库的做法直接走内部实现。
(async () => {
  const internals = window.__TAURI_INTERNALS__;
  const probe = { armed: null, firstFrameMs: null, settled: false };
  window.__armProbe = probe;
  const handler = internals.transformCallback(() => {
    probe.armed = Math.round(performance.now());
    const start = probe.armed;
    requestAnimationFrame(() => {
      // 窗口藏起来时 `rAF` 会被节流；能在一帧里回来，就说明亮出来之后没有多余的一段。
      probe.firstFrameMs = Math.round(performance.now() - start);
      probe.settled = true;
    });
  });
  await internals.invoke("plugin:event|listen", {
    event: "screenshot:armed",
    target: { kind: "Any" },
    handler,
  });
  return { installed: true };
})();