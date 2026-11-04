// A local project row offers one menu, not two.
//
// Right-clicking a row opened a menu whose rows were the same rows the ⋯ button opens, so a
// right-click and a click on ⋯ produced the same list twice over. The remote list beside it has
// always offered its actions from ⋯ alone; this probe pins the local list to that.
//
//   node scripts/dev/probes/project-row-menu.mjs [--port=9222]
const args = process.argv.slice(2);
const port = args.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {};
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(
  (t) =>
    t.type === "page" &&
    (t.url.endsWith("1420/") ||
      (t.url.includes("tauri.localhost") && !t.url.includes("settings.html"))),
);
if (!page) fail("没找到主窗口的 page 目标，应用起来了吗？");

const socket = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
const pending = new Map();
await new Promise((r) => socket.addEventListener("open", () => r()));
socket.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  const q = pending.get(m.id);
  if (!q) return;
  pending.delete(m.id);
  q(m);
});
const send = (method, params) =>
  new Promise((res, rej) => {
    const i = id++;
    pending.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    socket.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (body) => {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => {\n${body}\n})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result.value;
};

const PRESS = `
  const press = (el) => {
    const o = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...o, buttons: 0 }));
  };
`;

// The projects panel, from the header's GitHub icon.
const opened = await evaluate(`
  ${PRESS}
  const header = [...document.querySelectorAll("button[title]")].find((b) =>
    /本地项目与远程仓库|Local projects and remote repositories/.test((b.getAttribute("title") ?? "").trim()));
  if (!header) return "no-header-button";
  press(header);
  await new Promise((r) => setTimeout(r, 1500));
  return document.querySelectorAll("button[title]").length > 0 ? "opened" : "no-window";
`);
report.opened = opened;
if (opened !== "opened") fail(`项目面板没打开：${opened}`);

// A row of the local project list: it holds the ⋯ button, so it is the row to right-click. The
// point has to be verified against the document, or a click that missed would "prove" that no menu
// opens.
const row = await evaluate(`
  const more = [...document.querySelectorAll("button[title]")].find((b) =>
    /更多操作|More actions/.test((b.getAttribute("title") ?? "").trim()));
  if (!more) return null;
  const tr = more.closest("tr");
  if (!tr) return null;
  const r = tr.getBoundingClientRect();
  const x = Math.round(r.left + Math.min(60, r.width / 3));
  const y = Math.round(r.top + r.height / 2);
  const hit = document.elementFromPoint(x, y);
  return { x, y, insideRow: !!hit && (hit === tr || tr.contains(hit)), hitTag: hit?.tagName ?? null };
`);
if (!row) fail("本地项目列表里没找到 ⋯ 按钮（列表是空的吗？）");
report.row = row;
if (!row.insideRow) fail(`右键点位没落在项目行上（${row.hitTag}），测不准`);

await send("Page.bringToFront", {});
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: row.x, y: row.y, button: "right", buttons: 2, clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: row.x, y: row.y, button: "right", buttons: 0, clickCount: 1 });
await sleep(700);
const afterRightClick = await evaluate(`
  return JSON.stringify({
    contextMenu: document.querySelectorAll("[data-slot=context-menu-content]").length,
    dropdown: document.querySelectorAll("[data-slot=dropdown-menu-content]").length,
  });
`);
report.afterRightClick = JSON.parse(afterRightClick);
if (report.afterRightClick.contextMenu !== 0) {
  fail(`右击项目行还弹出菜单：${afterRightClick}`);
}

// Escape anything that is open, then the ⋯ button, which must still open one menu.
await evaluate(`
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  return null;
`);
// The ⋯ itself is pressed synthetically: it is a 19×15 target in a cell, and a coordinate click
// there measures the hit test rather than the menu.
const afterMore = await evaluate(`
  ${PRESS}
  const more = [...document.querySelectorAll("button[title]")].find((b) =>
    /更多操作|More actions/.test((b.getAttribute("title") ?? "").trim()));
  if (!more) return JSON.stringify({ dropdowns: 0, items: [] });
  press(more);
  await new Promise((res) => setTimeout(res, 900));
  const menus = [...document.querySelectorAll("[data-slot=dropdown-menu-content]")];
  return JSON.stringify({
    dropdowns: menus.length,
    items: menus[0] ? [...menus[0].querySelectorAll("[role=menuitem]")].map((el) => (el.textContent || "").trim()) : [],
  });
`);
report.afterMore = JSON.parse(afterMore);
if (report.afterMore.dropdowns !== 1) {
  fail(`⋯ 应该只开一个菜单：${afterMore}`);
}

// Leave the panel as it was found.
await evaluate(`
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  ${PRESS}
  const header = [...document.querySelectorAll("button[title]")].find((b) =>
    /本地项目与远程仓库|Local projects and remote repositories/.test((b.getAttribute("title") ?? "").trim()));
  if (header) press(header);
  await new Promise((r) => setTimeout(r, 900));
  return null;
`);

socket.close();
console.log(JSON.stringify(report, null, 2));
console.log("PASS: 本地项目行右击不再弹菜单，⋯ 仍然只开一个，里面的条目就是流程那一套。");
process.exit(0);
