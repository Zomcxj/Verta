// Send real input to one of the dev instance's WebView2 pages (CDP Input.dispatch*).
//
// Why a separate script instead of cdp-key.mjs: the screenshot overlay is a **second** page, so keys and
// mouse events have to go to the right window; cdp-key only ever picks the first page and cannot drag. This
// one selects the window via `--match` and supports a full drag
// (mousePressed → several mouseMoved → mouseReleased), which cannot be faked with a synthesized
// PointerEvent in the DOM, because setPointerCapture only accepts a real, currently pressed pointer.
//
// Usage:
//   1) WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 pnpm tauri dev
//   2) node scripts/dev/cdp-input.mjs --match=screenshot.html --drag=100,200,300,400
//      node scripts/dev/cdp-input.mjs --click=100,200
//      node scripts/dev/cdp-input.mjs --match=screenshot.html --key=Escape
//      node scripts/dev/cdp-input.mjs --click=1,2 --steps=8   # more intermediate moves for a drag
const [, , ...args] = process.argv;
const port = args.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const match = args.find((a) => a.startsWith("--match="))?.slice(8) ?? null;
const click = args.find((a) => a.startsWith("--click="))?.slice(8) ?? null;
const drag = args.find((a) => a.startsWith("--drag="))?.slice(7) ?? null;
const key = args.find((a) => a.startsWith("--key="))?.slice(6) ?? null;
const steps = Number(args.find((a) => a.startsWith("--steps="))?.slice(8) ?? "5");

if (!click && !drag && !key) {
  console.error(
    "用法: node scripts/dev/cdp-input.mjs [--match=<片段>] (--click=x,y | --drag=x0,y0,x1,y1 | --key=Escape)",
  );
  process.exit(2);
}

const point = (text) => {
  const m = /^(-?\d+),(-?\d+)$/.exec(text);
  if (!m) {
    console.error(`坐标要写成 x,y，收到的是：${text}`);
    process.exit(2);
  }
  return { x: Number(m[1]), y: Number(m[2]) };
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const pages = targets.filter((t) => t.type === "page");
if (pages.length === 0) {
  console.error("没找到 page 目标（dev 实例起来了吗？）");
  process.exit(1);
}
// Try an exact URL match first, then fall back to a substring: the main window URL is
// `http://localhost:1420/` and the overlay is `http://localhost:1420/screenshot.html`, so a substring
// search alone picks the wrong window (fragments like `/?` match both).
const page = match
  ? (pages.find((t) => t.url === match) ??
    pages.find((t) => t.url.includes(match) || (t.title ?? "").includes(match)))
  : pages[0];
if (!page) {
  console.error(
    `没找到页面（--match=${match}）。当前有：\n${pages.map((t) => `  ${t.title ?? ""} ${t.url}`).join("\n")}`,
  );
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
const opened = new Promise((resolve, reject) => {
  socket.addEventListener("open", () => resolve());
  socket.addEventListener("error", (e) => reject(new Error(`WebSocket 出错: ${e.message ?? ""}`)));
});
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  entry(message);
});
const send = async (method, params) => {
  await opened;
  const id = nextId++;
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 30_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
  socket.send(JSON.stringify({ id, method, params }));
  return answer;
};

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const mouse = (type, { x, y }, extra = {}) =>
  send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: "left",
    clickCount: 1,
    ...extra,
  });

if (click) {
  const at = point(click);
  await mouse("mouseMoved", at, { button: "none", buttons: 0 });
  await mouse("mousePressed", at, { buttons: 1 });
  await mouse("mouseReleased", at, { buttons: 0 });
}

if (drag) {
  const parts = drag.split(",");
  if (parts.length !== 4) {
    console.error(`拖拽要写成 x0,y0,x1,y1，收到的是：${drag}`);
    process.exit(2);
  }
  const from = point(`${parts[0]},${parts[1]}`);
  const to = point(`${parts[2]},${parts[3]}`);
  await mouse("mouseMoved", from, { button: "none", buttons: 0 });
  await mouse("mousePressed", from, { buttons: 1 });
  // Several real moves in between are required: drag handling accumulates on pointermove, so
  // pressing and releasing in place is treated as "no drag".
  for (let step = 1; step <= steps; step += 1) {
    const at = {
      x: Math.round(from.x + ((to.x - from.x) * step) / steps),
      y: Math.round(from.y + ((to.y - from.y) * step) / steps),
    };
    await mouse("mouseMoved", at, { buttons: 1 });
    await pause(12);
  }
  await mouse("mouseReleased", to, { buttons: 0 });
}

if (key) {
  const KEYS = {
    Escape: { code: "Escape", keyCode: 27, text: "" },
    Enter: { code: "Enter", keyCode: 13, text: "\r" },
  };
  const spec = KEYS[key];
  if (!spec) {
    console.error(`未定义的键：${key}。可用：${Object.keys(KEYS).join(", ")}`);
    process.exit(2);
  }
  const base = {
    key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
  };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: spec.text });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

socket.close();
console.log(`已发到 ${page.title ?? ""} ${page.url}`);