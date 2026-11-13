// 无界 closes the gutters between the three regions, and with them the only line that said where the
// seam was: the handle is 0px wide, so the drag worked and gave no sign of where it was happening.
//
// The claim is "a line appears while the seam is being used", which is a fact about a painted
// pseudo-element under a pointer state - so it is measured under a real pointer: the stripe's own
// computed style at rest (invisible), after a mouse move onto the seam (visible), and with the button
// held (still visible, and the library agrees a separator is active). Nothing is resized: the press is
// released where it started, and the panel widths are compared before and after to prove it.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/boundless-drag-line.mjs [--port=9222]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";

const report = {};
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url === "http://tauri.localhost/");
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
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const what = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`${what} in: ${expression.slice(0, 160)}`);
  }
  return result.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The seam, what it paints, and the widths either side of it. */
const SNAPSHOT = `(() => {
  const handle = document.querySelector('[data-slot="resizable-handle"]');
  if (!handle) return JSON.stringify({ found: false });
  const box = handle.getBoundingClientRect();
  const stripe = getComputedStyle(handle, "::after");
  const group = handle.parentElement;
  const panels = group
    ? [...group.querySelectorAll('[data-slot="resizable-panel"]')].map((panel) =>
        Math.round(panel.getBoundingClientRect().width),
      )
    : [];
  return JSON.stringify({
    found: true,
    shape: document.documentElement.dataset.shape ?? null,
    center: { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) },
    handleWidth: Math.round(box.width),
    state: handle.getAttribute("data-separator"),
    stripe: {
      opacity: stripe.opacity,
      background: stripe.backgroundImage.slice(0, 120),
      width: stripe.width,
    },
    panels,
  });
})()`;

const snapshot = async () => JSON.parse(await evaluate(SNAPSHOT));
/**
 * Moves the real pointer, then waits for the state to settle.
 *
 * Two moves, not one: a single synthetic move lands the pointer on the seam but the pseudo-element's
 * style is resolved on the next move - measured here, one move read `opacity: 0` while the handle
 * already matched `:hover`, and the pair read 1. The settle is longer than the stripe's own opacity
 * transition (`--dur-fast`), so the reading is the state and not a frame of the fade.
 */
const pointer = async (type, x, y, buttons = 0) => {
  const button = type === "mouseMoved" && buttons === 0 ? "none" : "left";
  if (type === "mouseMoved") {
    await send("Input.dispatchMouseEvent", { type, x: x - 24, y, button, buttons });
    await sleep(120);
  }
  await send("Input.dispatchMouseEvent", { type, x, y, button, buttons, clickCount: 1 });
  await sleep(260);
};

try {
  // "At rest" means the pointer is somewhere else: a probe that starts wherever the last one left the
  // pointer reads the hover state and calls it the idle one (it did, and reported the seam as always
  // on). The header is the furthest thing from the seam that is still the window.
  const viewport = JSON.parse(
    await evaluate("JSON.stringify({ w: innerWidth, h: innerHeight })"),
  );
  await pointer("mouseMoved", Math.round(viewport.w / 2), 20);
  const atRest = await snapshot();
  report.atRest = atRest;
  if (!atRest.found) fail("the shell has no resize handle to look at");
  if (atRest.shape !== "boundless") {
    fail(
      `this checks 无界 (and reads its zero-width handle), but the window is drawing ${atRest.shape}`,
    );
  }
  if (atRest.handleWidth !== 0) {
    fail(`the handle is ${atRest.handleWidth}px wide: it is not merging the regions, so there is no seam to draw`);
  }
  if (!/linear-gradient/.test(atRest.stripe.background)) {
    fail(`the handle's hit area paints no stripe at all: ${atRest.stripe.background}`);
  }
  if (atRest.stripe.opacity !== "0") {
    fail(`the seam is visible at rest (opacity ${atRest.stripe.opacity}): 无界 has no seams when idle`);
  }

  // ---- The pointer arrives --------------------------------------------------------------------
  await pointer("mouseMoved", atRest.center.x, atRest.center.y);
  const hovered = await snapshot();
  report.hovered = hovered;
  if (hovered.stripe.opacity === "0") {
    fail("moving the pointer onto the seam draws nothing: the drag has no handle to aim at");
  }
  if (!hovered.stripe.background.includes("linear-gradient")) {
    fail(`the visible seam paints no stripe: ${hovered.stripe.background}`);
  }

  // ---- The button goes down: the whole drag has to keep it visible ----------------------------
  await pointer("mousePressed", atRest.center.x, atRest.center.y, 1);
  const dragging = await snapshot();
  report.dragging = dragging;
  if (dragging.stripe.opacity === "0") {
    fail("the stripe disappears once the drag starts, which is the moment it exists for");
  }

  // ---- Released where it started: nothing was resized ------------------------------------------
  await pointer("mouseReleased", atRest.center.x, atRest.center.y, 0);
  await sleep(300);
  const after = await snapshot();
  report.after = after;
  if (JSON.stringify(after.panels) !== JSON.stringify(atRest.panels)) {
    fail(
      `the press-and-release changed the layout: ${atRest.panels.join("/")} -> ${after.panels.join("/")}`,
    );
  }

  console.log(
    `PASS: 无界下握把宽 ${atRest.handleWidth}px（区域已并成一张纸），静止时 ::after 上的 ${atRest.stripe.width} 竖线透明度 ${atRest.stripe.opacity}（看不见）；鼠标移到缝隙上后透明度 ${hovered.stripe.opacity}（线出现，渐变 ${hovered.stripe.background.includes("linear-gradient") ? "是" : "不是"}）；按住拖动时透明度 ${dragging.stripe.opacity}、库报的 data-separator=${JSON.stringify(dragging.state)}；原位松开后各面板宽度 ${after.panels.join("/")} 与按下前 ${atRest.panels.join("/")} 一致。`,
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    `FAIL: ${error instanceof ProbeFailure ? error.message : String(error?.message ?? error)}`,
  );
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  socket.close();
}
