// A project row, end to end, on a running window: open the projects panel from the header, make
// sure the source column is closed, hover a project's name, press it, and read the layout again.
//
// The card that used to appear beside a project's name was asked to go, and a hover card is
// invisible in any diff - it is a popper created on a pointer move. The press is checked from a
// closed column, because "opens" and "toggles" look identical while the column is already open,
// and the terminal it opens is what catches a callback that quietly never runs.
//
// Usage:
//   node scripts/dev/probes/project-row.mjs --match=http://tauri.localhost/ --name=Verta
//
// Name the window by its whole address: the settings page shares the origin, and a shorter name
// reads whichever of the two the debugger lists first.

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const match = arg("match") ?? "http://tauri.localhost/";
const wantName = arg("name") ?? "Verta";

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
const click = async (x, y) => {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
};
const buttonAt = (title) =>
  evalIn(`
    const b = [...document.querySelectorAll("button[title]")].find(b => b.getAttribute("title") === ${JSON.stringify(title)});
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
  `);
const widths = () =>
  evalIn(`return [...document.querySelectorAll("[data-panel]")].map(p => Math.round(p.getBoundingClientRect().width));`);
const tabs = () => evalIn(`return document.querySelectorAll("[data-tab-id]").length;`);

const failures = [];
const report = {};

// 1) The projects panel, from the header button.
const projectsBtn = await buttonAt("本地项目与远程仓库");
if (!projectsBtn) {
  console.error("找不到「本地项目与远程仓库」按钮");
  process.exit(1);
}
await click(projectsBtn[0], projectsBtn[1]);
await sleep(2500);

const row = await evalIn(`
  const tr = [...document.querySelectorAll("tbody tr")].find(tr => (tr.textContent || "").includes(${JSON.stringify(wantName)}));
  const b = tr?.querySelector("td button");
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { name: (b.textContent || "").trim(), at: [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] };
`);
if (!row) {
  console.error(`项目列表里没有名字含「${wantName}」的行（列表在屏幕上吗？）`);
  process.exit(2);
}
report.row = row.name;

// 2) Close the source column first, so "opened" and "toggled" are distinguishable.
const before = await widths();
report.widthsBeforeClose = before;
const gitBtn = await buttonAt("显示/隐藏 Git 面板");
if (Math.max(...before) > 0 && Math.max(...before.slice(2)) > 0) {
  await click(gitBtn[0], gitBtn[1]);
  await sleep(1200);
}
report.widthsClosed = await widths();
if ((report.widthsClosed[report.widthsClosed.length - 1] ?? 0) !== 0) {
  failures.push(`右栏没关上（${JSON.stringify(report.widthsClosed)}），这一轮分不清"开"与"切换"`);
}

// 3) Hover the name: nothing may appear.
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: row.at[0], y: row.at[1], button: "none" });
await sleep(800);
report.poppersOnHover = await evalIn(`
  return document.querySelectorAll("[data-radix-popper-content-wrapper], [data-slot=hover-card-content]").length;
`);
if (report.poppersOnHover !== 0) {
  failures.push(`悬停项目名弹出了 ${report.poppersOnHover} 个浮层`);
}

// 4) Press it.
const tabsBefore = await tabs();
await click(row.at[0], row.at[1]);
await sleep(2500);
report.tabs = [tabsBefore, await tabs()];
report.widthsAfterPress = await widths();

const right = report.widthsAfterPress[report.widthsAfterPress.length - 1] ?? 0;
if (right === 0) failures.push(`按下项目名后右栏仍是 0 宽（源码面板没打开）`);
if (report.tabs[1] <= report.tabs[0]) {
  failures.push(`按下项目名没有开出终端标签（${report.tabs[0]} → ${report.tabs[1]}）`);
}

console.log(JSON.stringify(report, null, 1));
if (failures.length === 0) {
  console.log("\n通过：悬停不出卡，按下后右栏打开（不是被收起）、终端也开了。");
  process.exit(0);
}
console.log("\n不通过：");
for (const line of failures) console.log(`  - ${line}`);
process.exit(1);
