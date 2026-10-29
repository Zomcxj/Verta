// A project's run detail: the corner where "open on GitHub" and the panel's close button meet.
//
// Both are drawn in the same top-right corner - the panel's close button is absolutely placed there
// by the shared dialog style, and the detail view's first row ends with the GitHub button. Nothing
// about that is visible in the source once the class that holds them apart is removed: the reading
// that matters is whether one button's box overlaps the other's, and which of the two a press at the
// shared point lands on.
//
// Usage:
//   node scripts/dev/probes/run-detail-corner.mjs --match=http://tauri.localhost/
//
// Opens the run detail itself: the remote list, the first repository's CI column, the first run's
// own detail. It leaves the panel open so a screenshot can be taken next.
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const match = arg("match") ?? "http://tauri.localhost/";

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

/** Press a button by its visible words, inside the open panel. */
const pressIn = async (words) => {
  const at = await evalIn(`
    const panel = document.querySelector("[data-slot=dialog-content]");
    const b = [...(panel?.querySelectorAll("button") ?? [])].find((b) => (b.textContent || "").trim() === ${JSON.stringify(words)});
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
  `);
  if (!at) return null;
  await press(at[0], at[1]);
  return at;
};

const remoteTab = await evalIn(`
  const b = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "远程仓库");
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
`);
if (!remoteTab) {
  console.error("没找到「远程仓库」切换器：先从左栏打开「本地项目」面板再跑");
  process.exit(2);
}
await press(remoteTab[0], remoteTab[1]);
await sleep(3500);

const ciAt = await evalIn(`
  const table = [...document.querySelectorAll("table")].find((t) =>
    /^仓库归属可见性/.test((t.querySelector("thead")?.textContent || "").replace(/\\s+/g, ""))
  );
  // The first row that has a run at all: the newest repository on this machine has no CI, and a
  // probe that presses its empty cell measures nothing.
  const rows = [...(table?.querySelectorAll("tbody tr") ?? [])];
  const find = (row) => [...row.querySelectorAll("button")].find((b) => /通过|失败|未检查|检查中/.test((b.textContent || "").trim()));
  const row = rows.find((r) => find(r)) ?? null;
  const b = row ? find(row) : null;
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
`);
if (!ciAt) {
  console.error("远程仓库那张表里没有 CI 格可点");
  process.exit(2);
}
await press(ciAt[0], ciAt[1]);
await sleep(4000);
if ((await pressIn("详情")) === null) {
  console.error("运行记录面板里没有「详情」可点（这个仓库可能没有运行记录）");
  process.exit(2);
}
await sleep(5000);

const reading = await evalIn(`
  const panel = document.querySelector("[data-slot=dialog-content]");
  if (!panel) return { open: false };
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) };
  };
  const github = [...panel.querySelectorAll("button")].find((b) => /GitHub/i.test(b.textContent || ""));
  const close = panel.querySelector("[data-slot=dialog-close]");
  const g = box(github);
  const c = box(close);
  const overlaps =
    g && c && g.left < c.right && c.left < g.right && g.top < c.bottom && c.top < g.bottom;
  const shared = g && c ? [Math.round((Math.max(g.left, c.left) + Math.min(g.right, c.right)) / 2), Math.round((Math.max(g.top, c.top) + Math.min(g.bottom, c.bottom)) / 2)] : null;
  const hit = shared ? document.elementFromPoint(shared[0], shared[1]) : null;
  return {
    open: true,
    github: g,
    close: c,
    overlaps: Boolean(overlaps),
    shared,
    hitAtShared: hit ? (hit.textContent || "").trim().slice(0, 20) : null
  };
`);

if (!reading.open) {
  console.error("面板没打开");
  process.exit(1);
}

console.log(`「在 GitHub 打开」${JSON.stringify(reading.github)}`);
console.log(`关闭按钮          ${JSON.stringify(reading.close)}`);
const failures = [];
if (!reading.github) failures.push("第一行里没有「在 GitHub 打开」（文本里找不到 GitHub）");
if (!reading.close) failures.push("面板上没有关闭按钮");
if (reading.overlaps) {
  failures.push(`两个按钮的框重合了：交点上压着的是「${reading.hitAtShared}」`);
}

if (failures.length === 0) {
  console.log("\n通过：两个按钮不重合，点哪儿算哪儿。");
  process.exit(0);
}
console.log("\n不通过：");
for (const line of failures) console.log(`  - ${line}`);
process.exit(1);
