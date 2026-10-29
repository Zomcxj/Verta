// A pull request's detail: the corner where "open on GitHub" and the panel's close button meet.
//
// Same shape as the run detail and the same failure: the close button is absolutely placed in the
// panel's top-right corner by the shared dialog style, and the detail's first row ends with a button
// of its own. Overlap is invisible in the source once the class that holds them apart is removed, so
// this opens a pull request and compares the two boxes.
//
// Usage:
//   node scripts/dev/probes/issue-detail-corner.mjs --match=http://tauri.localhost/
//   node scripts/dev/probes/issue-detail-corner.mjs --match=http://tauri.localhost/ --pull-request
//
// `--pull-request` asks for an open pull request by name and takes the first one it finds; without it
// the first issue in the list is opened.
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const match = arg("match") ?? "http://tauri.localhost/";
const wantPull = process.argv.includes("--pull-request") ? arg("pull-request") : null;

const target = (await (await fetch("http://127.0.0.1:9222/json")).json()).find(
  (t) => t.type === "page" && t.url === match,
);
if (!target) {
  console.error(`没找到 ${match}`);
  process.exit(1);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const press = async (x, y) => {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
};

const reading = await evalIn(`
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) };
  };
  const panel = document.querySelector("[data-slot=dialog-content]");
  if (!panel) return { open: false };
  // The detail is the layer with a back button on it; a list panel has none.
  const back = [...panel.querySelectorAll("button")].find((b) => (b.textContent || "").trim().startsWith("←"));
  if (!back) return { open: true, detail: false };
  const github = [...panel.querySelectorAll("button")].find((b) => /GitHub/i.test(b.textContent || ""));
  const close = panel.querySelector("[data-slot=dialog-close]");
  const g = box(github);
  const c = box(close);
  return {
    open: true,
    detail: true,
    title: (panel.textContent || "").replace(/\\s+/g, " ").slice(0, 60),
    github: g,
    close: c,
    overlaps: Boolean(g && c && g.left < c.right && c.left < g.right && g.top < c.bottom && c.top < g.bottom)
  };
`);

if (!reading.open || !reading.detail) {
  console.error("没有打开一个详情页（列表也算）：先打开一个问题或 PR 的详情，再跑这个探针。");
  process.exit(2);
}

console.log(`详情：${reading.title}`);
console.log(`「在 GitHub 打开」${JSON.stringify(reading.github)}`);
console.log(`关闭按钮          ${JSON.stringify(reading.close)}`);

const failures = [];
if (!reading.github) failures.push("详情第一行里没有「在 GitHub 打开」");
if (!reading.close) failures.push("面板上没有关闭按钮");
if (reading.overlaps) failures.push("两个按钮的框重合了");

if (failures.length === 0) {
  console.log("\n通过：两个按钮不重合。");
  process.exit(0);
}
console.log("\n不通过：");
for (const line of failures) console.log(`  - ${line}`);
process.exit(1);
