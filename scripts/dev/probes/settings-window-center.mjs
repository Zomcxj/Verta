// Where the settings window opens.
//
// "Always centred" is a claim about a window's position, and a window's position is the one thing
// the source cannot show: the window-state plugin saves and restores it, so a window that is
// centred when it is built can come back wherever it was last moved. This measures the live
// window instead: its box against the middle of the screen it is on.
//
// Both the full monitor and its work area are reported, because "centred" is only meaningful
// against one of them and the answer differs by the height of the taskbar.
//
// Usage:
//   node scripts/dev/probes/settings-window-center.mjs --match=http://tauri.localhost/settings.html
//   node scripts/dev/probes/settings-window-center.mjs --tolerance=4
//
// The settings window has to be open. Exits 2 when it is not there: nothing measured is not a pass.
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const match = arg("match") ?? "http://tauri.localhost/settings.html";
const tolerance = Number(arg("tolerance") ?? "3");

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const target = targets.find((t) => t.type === "page" && t.url.startsWith(match));
if (!target) {
  console.error(`没找到设置窗口（${match}）：先把设置窗口打开再跑这个探针。`);
  process.exit(2);
}
const socket = new WebSocket(target.webSocketDebuggerUrl);
let id = 1;
const pending = new Map();
await new Promise((r) => socket.addEventListener("open", () => r()));
socket.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  pending.get(m.id)?.(m);
  pending.delete(m.id);
});
const send = (method, params) =>
  new Promise((res, rej) => {
    const i = id++;
    pending.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    socket.send(JSON.stringify({ id: i, method, params }));
  });
const evalIn = async (body) => {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => {\n${body}\n})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

const box = await evalIn(`
  return {
    x: Math.round(window.screenX),
    y: Math.round(window.screenY),
    w: Math.round(window.outerWidth),
    h: Math.round(window.outerHeight),
    screen: { w: window.screen.width, h: window.screen.height },
    work: { w: window.screen.availWidth, h: window.screen.availHeight },
    dpr: window.devicePixelRatio,
  };
`);

const middle = (total, size) => Math.round((total - size) / 2);
const centre = {
  onScreen: {
    x: middle(box.screen.w, box.w),
    y: middle(box.screen.h, box.h),
  },
  onWork: {
    x: middle(box.work.w, box.w),
    y: middle(box.work.h, box.h),
  },
};
const delta = (want) => ({
  x: Math.abs(box.x - want.x),
  y: Math.abs(box.y - want.y),
});
const dScreen = delta(centre.onScreen);
const dWork = delta(centre.onWork);

console.log(`窗口  ${box.w}x${box.h} @(${box.x},${box.y})   缩放 ${box.dpr}`);
console.log(`屏幕  ${box.screen.w}x${box.screen.h} → 正中 (${centre.onScreen.x},${centre.onScreen.y})  差 ${dScreen.x},${dScreen.y}`);
console.log(`工作区 ${box.work.w}x${box.work.h} → 正中 (${centre.onWork.x},${centre.onWork.y})  差 ${dWork.x},${dWork.y}`);

// Either reading counts: Tauri centres against the monitor, and a window that lands in the middle
// of the work area is in the middle as far as anyone looking at it is concerned.
const centred =
  (dScreen.x <= tolerance && dScreen.y <= tolerance) ||
  (dWork.x <= tolerance && dWork.y <= tolerance);

if (centred) {
  console.log(`\n通过：窗口在屏幕正中（误差 ≤ ${tolerance}px）。`);
  process.exit(0);
}
console.log(`\n不通过：窗口不在正中，离屏幕中心 ${dScreen.x},${dScreen.y} px、离工作区中心 ${dWork.x},${dWork.y} px。`);
process.exit(1);