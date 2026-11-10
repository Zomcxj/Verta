// Acceptance for the two side panels: opening and closing them is drawn, not snapped.
//
// They are `react-resizable-panels` panels, so their width is an inline `flex-basis` the library
// writes, and `collapse()` / `resize()` move it in one step - which is what the eye reads as the
// layout flinching. The stylesheet animates that one property, but only while a toggle is in flight
// (`data-panel-slide` on the group): dragging a divider rewrites `flex-basis` on every pointer move,
// and a transition there would leave the edge trailing behind the pointer.
//
// So the width is sampled frame by frame while each side is toggled, and the numbers have to show a
// real travel - several intermediate widths, ending at the other end - rather than one jump. The
// same measurement is then repeated with reduced motion emulated, where the tokens are zeroed and the
// answer has to be a snap.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/panel-slide.mjs [--port=9222]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";

const report = {};
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

/** How a control is pressed. Radix and the app's own handlers react to a press, not to a click. */
const PRESS = `const press = (node) => {
  const options = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
  node.dispatchEvent(new PointerEvent("pointerdown", options));
  node.dispatchEvent(new PointerEvent("pointerup", { ...options, buttons: 0 }));
  node.dispatchEvent(new MouseEvent("click", { ...options, buttons: 0 }));
};`;

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
// The main window, not whichever page carries the app's origin: a settings window is a page of the
// same origin and has no panel group in it.
const page =
  targets.find((t) => t.type === "page" && t.url === "http://tauri.localhost/") ??
  targets.find((t) => t.type === "page" && t.url.endsWith("1420/")) ??
  targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost")) ??
  targets.find((t) => t.type === "page");
if (!page) fail("no page target: is the app running with --remote-debugging-port?");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve);
  socket.addEventListener("error", (e) => reject(new Error(String(e?.message ?? e))));
});
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
  else entry.resolve(message.result);
});
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      `${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text} in: ${expression.slice(0, 200)}`,
    );
  }
  return result.result.value;
};

/**
 * The panel's width, frame by frame, with the press landing 120 ms in.
 *
 * The panels are in the group's own order - sidebar, workspace, the Git panel - and the index picks
 * one. `pressSource` runs inside the page at that moment, or `null` when the press comes from the
 * debugger instead (a shortcut the window has to receive as real input).
 */
const sampleToggle = async (index, pressSource, windowMs = 1000) =>
  JSON.parse(
    await evaluate(`(async () => {
      ${PRESS}
      const group = document.querySelector('[data-slot="resizable-panel-group"]');
      if (!group) return JSON.stringify({ error: "no panel group" });
      const panel = group.querySelectorAll('[data-slot="resizable-panel"]')[${index}];
      if (!panel) return JSON.stringify({ error: "no panel at index ${index}" });
      const started = performance.now();
      const widths = [];
      const sliding = [];
      let overflow = 0;
      let pressed = false;
      let pressedAt = null;
      await new Promise((resolve) => {
        const tick = () => {
          const now = performance.now() - started;
          widths.push(Math.round(panel.getBoundingClientRect().width * 100) / 100);
          sliding.push(group.hasAttribute("data-panel-slide") ? 1 : 0);
          const doc = document.documentElement;
          overflow = Math.max(overflow, doc.scrollWidth - doc.clientWidth);
          if (!pressed && now >= 120) {
            pressed = true;
            pressedAt = Math.round(now);
            ${pressSource ?? "0;"}
          }
          if (now < ${windowMs}) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      const distinct = [...new Set(widths)];
      return JSON.stringify({
        pressedAt,
        samples: widths.length,
        distinct: distinct.length,
        first: widths[0],
        last: widths[widths.length - 1],
        slidingAtStart: sliding[0] === 1,
        slidingSamples: sliding.filter(Boolean).length,
        documentOverflow: overflow,
        widths,
      });
    })()`),
  );

/** Ctrl+<key> the way the window receives it, for the shortcut that has no button on screen. */
const sendChord = async (key, virtualKeyCode) => {
  await send("Page.bringToFront");
  await sleep(120);
  for (const type of ["rawKeyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type,
      modifiers: 2,
      key,
      code: `Key${key.toUpperCase()}`,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
    });
  }
};

/** Which side is which: the Git panel's toggle is the `pane.source` chord, the sidebar has a button. */
const SIDEBAR_BUTTON = `(() => {
  const button = [...document.querySelectorAll("button[title]")].find((node) =>
    /显示\\/隐藏侧栏|toggle sidebar/i.test(node.getAttribute("title") || ""),
  );
  if (!button) return "no sidebar toggle button";
  press(button);
  return null;
})()`;

try {
  // ---- The left side: closed and opened again, both measured ----
  const leftClose = await sampleToggle(0, SIDEBAR_BUTTON);
  if (leftClose.error) fail(leftClose.error);
  report.leftClose = leftClose;
  await sleep(500);
  const leftOpen = await sampleToggle(0, SIDEBAR_BUTTON);
  if (leftOpen.error) fail(leftOpen.error);
  report.leftOpen = leftOpen;

  // ---- The right side, which is the `pane.source` chord ----
  const rightFirst = sampleToggle(2, null);
  await sleep(120);
  await sendChord("g", 71);
  const rightOne = await rightFirst;
  if (rightOne.error) fail(rightOne.error);
  report.rightFirst = rightOne;
  await sleep(500);
  const rightSecond = sampleToggle(2, null);
  await sleep(120);
  await sendChord("g", 71);
  const rightTwo = await rightSecond;
  if (rightTwo.error) fail(rightTwo.error);
  report.rightSecond = rightTwo;

  // ---- What a slide has to look like ----
  const sides = [
    ["左侧栏 · 关", leftClose],
    ["左侧栏 · 开", leftOpen],
    ["右侧栏 · 第一次", rightOne],
    ["右侧栏 · 第二次", rightTwo],
  ];
  for (const [name, run] of sides) {
    if (Math.abs(run.last - run.first) < 40) {
      fail(`${name} 的宽度没有变（${run.first} -> ${run.last}），这条探针什么都没测到`);
    }
    if (run.distinct < 3) {
      fail(
        `${name} 是一步到位的（${run.first} -> ${run.last}，只有 ${run.distinct} 个不同宽度）：${JSON.stringify(run.widths)}`,
      );
    }
    if (run.slidingAtStart) {
      fail(`${name} 开始采样时过渡标记还没清掉：上一个动画窗口没有结束`);
    }
    if (run.slidingSamples === 0) {
      fail(`${name} 全程没有 data-panel-slide，说明过渡根本没挂上：${JSON.stringify(run.widths)}`);
    }
    if (run.documentOverflow > 0) {
      fail(`${name} 动画期间出现了横向溢出（${run.documentOverflow}px），面板没有把内容裁住`);
    }
  }

  // ---- And with reduced motion, the same toggle has to snap ----
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await sleep(200);
  const reduced = await sampleToggle(0, SIDEBAR_BUTTON);
  if (reduced.error) fail(reduced.error);
  report.reducedMotion = reduced;
  await send("Emulation.setEmulatedMedia", { features: [] });
  if (Math.abs(reduced.last - reduced.first) < 40) {
    fail("减少动效时侧栏没有变化，这一条没法判");
  }
  if (reduced.distinct > 2) {
    fail(
      `减少动效下仍然是动画（${reduced.distinct} 个不同宽度）：${JSON.stringify(reduced.widths)}`,
    );
  }

  const stillSliding = await evaluate(
    `document.querySelector('[data-slot="resizable-panel-group"]').hasAttribute("data-panel-slide")`,
  );
  report.stillSliding = stillSliding;
  if (stillSliding) fail("toggle 都结束后 data-panel-slide 还挂在组上，之后拖分隔条会跟着动画");

  report.ok = true;
  console.log(
    `PASS: 两侧栏的展开/隐藏是画出来的——左侧 ${leftClose.distinct}/${leftOpen.distinct} 个中间宽度、右侧 ${rightOne.distinct}/${rightTwo.distinct} 个，全程无横向溢出；减少动效下 ${reduced.distinct} 个宽度（即时）。`,
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    `FAIL: ${error instanceof ProbeFailure ? error.message : String(error?.message ?? error)}`,
  );
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  try {
    await send("Emulation.setEmulatedMedia", { features: [] });
  } catch {
    // The window may already be gone.
  }
  socket.close();
}
