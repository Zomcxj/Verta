// Do the header's note and GitHub icons toggle? A click opens the tab each one is for,
// and a second click puts it away - which is what a person expects of an icon that is
// already lit by the thing it opened.
//
// The note half also checks the order the close path promises: the note is written before
// its tab goes, so reopening the tab finds what was typed.
//
//   node scripts/dev/probes/header-toggles.mjs [--port=9222]
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
  // The header's icon, by the title it carries (the accessible name for an icon button).
  const headerButton = (pattern) => [...document.querySelectorAll("button[title]")].find((b) =>
    pattern.test((b.getAttribute("title") ?? "").trim()));
  const chips = () => [...document.querySelectorAll("[data-tab-id]")].map((el) => (el.textContent || "").trim());
`;

const NOTES = "/^笔记$|^Notes$/";
const GITHUB = "/本地项目与远程仓库|Local projects and remote repositories/";

// --- the GitHub icon --------------------------------------------------------------------------
const github = await evaluate(`
  ${PRESS}
  const button = headerButton(${GITHUB});
  if (!button) return { step: "no-button" };
  const before = chips();
  press(button);
  await new Promise((r) => setTimeout(r, 1000));
  const opened = chips();
  press(headerButton(${GITHUB}));
  await new Promise((r) => setTimeout(r, 1000));
  const closed = chips();
  return { step: "done", before, opened, closed };
`);
report.github = github;
if (github.step !== "done") fail(`Header 上没找到 GitHub 图标：${github.step}`);
if (github.opened.length !== github.before.length + 1) {
  fail(`点 GitHub 图标应多出一个标签：之前 ${JSON.stringify(github.before)}，之后 ${JSON.stringify(github.opened)}`);
}
if (JSON.stringify(github.closed) !== JSON.stringify(github.before)) {
  fail(`再点一次 GitHub 图标应把它关掉：之前 ${JSON.stringify(github.before)}，现在 ${JSON.stringify(github.closed)}`);
}

// --- the note icon, and the write that close owes ----------------------------------------------
const openedOnce = await evaluate(`
  ${PRESS}
  const button = headerButton(${NOTES});
  if (!button) return { step: "no-button" };
  const before = chips();
  press(button);
  await new Promise((r) => setTimeout(r, 1400));
  return { step: "done", before, opened: chips() };
`);
report.notesOpen = openedOnce;
if (openedOnce.step !== "done") fail(`Header 上没找到笔记图标：${openedOnce.step}`);
if (openedOnce.opened.length !== openedOnce.before.length + 1) {
  fail(`点笔记图标应多出一个标签：之前 ${JSON.stringify(openedOnce.before)}，之后 ${JSON.stringify(openedOnce.opened)}`);
}

// Type into the note it picked, so the close has something to write.
const dir = await evaluate(
  `const invoke = window.__TAURI_INTERNALS__.invoke;
   return invoke("notes_dir");`,
);
report.dir = dir;
const { readFileSync, readdirSync } = await import("node:fs");
const notesBefore = readdirSync(dir).filter((name) => /\.md$/i.test(name));

const typed = "toggle closes and writes 开关关闭前写盘";
const wrote = await evaluate(`
  ${PRESS}
  const visible = (el) => {
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && el.offsetParent !== null;
  };
  const newButton = [...document.querySelectorAll("button")].find((b) => {
    const label = (b.textContent || "").trim();
    return label === "新建" || label === "New";
  });
  if (newButton) {
    press(newButton);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const el = [...document.querySelectorAll(".cm-content")].find(visible) ?? null;
  if (!el) return "no-editor";
  el.focus();
  const point = el.getBoundingClientRect();
  return JSON.stringify({ ok: true, x: Math.round(point.left + 60), y: Math.round(point.top + 20) });
`);
if (wrote === "no-editor") fail("笔记标签开了但编辑区没画出来");
const spot = JSON.parse(wrote);
await send("Page.bringToFront", {});
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: spot.x, y: spot.y, button: "left", buttons: 1, clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: spot.x, y: spot.y, button: "left", buttons: 0, clickCount: 1 });
await sleep(400);
await send("Input.insertText", { text: typed });
await sleep(600);

const notesAfterCreate = readdirSync(dir).filter((name) => /\.md$/i.test(name));
const fresh = notesAfterCreate.filter((name) => !notesBefore.includes(name));
report.freshNotes = fresh;
if (fresh.length !== 1) fail(`新建应留下正好一个 .md，实际 ${JSON.stringify(fresh)}`);
const noteName = fresh[0];

const closed = await evaluate(`
  ${PRESS}
  const button = headerButton(${NOTES});
  if (!button) return { step: "no-button" };
  const before = chips();
  press(button);
  await new Promise((r) => setTimeout(r, 1200));
  return { step: "done", before, closed: chips() };
`);
report.notesClose = closed;
if (closed.step !== "done") fail(`关笔记标签时没找到笔记图标：${closed.step}`);
if (closed.closed.length !== closed.before.length - 1) {
  fail(`再点一次笔记图标应把标签关掉：之前 ${JSON.stringify(closed.before)}，现在 ${JSON.stringify(closed.closed)}`);
}

// The write came first: the file holds what was typed, and the tab that was closed is gone.
const onDisk = readFileSync(`${dir}/${noteName}`, "utf8");
report.onDisk = onDisk;
if (!onDisk.includes(typed)) {
  fail(`关标签前没写盘：${JSON.stringify(onDisk)} 里没有 ${JSON.stringify(typed)}`);
}

// --- reopening finds it again ----------------------------------------------------------------
const reopened = await evaluate(`
  ${PRESS}
  const button = headerButton(${NOTES});
  if (!button) return { step: "no-button" };
  press(button);
  await new Promise((r) => setTimeout(r, 1400));
  return {
    step: "done",
    chips: chips(),
    listed: [...document.querySelectorAll("button")].some((b) => b.textContent.includes(${JSON.stringify(noteName)})),
  };
`);
report.reopened = reopened;
if (reopened.step !== "done") fail(`重开笔记标签没成：${reopened.step}`);
if (!reopened.listed) fail(`重开的标签里没有 ${noteName} 这一行`);

// Leave the window as it was found: the tab the probe opened is put away again.
await evaluate(`
  ${PRESS}
  const button = headerButton(${NOTES});
  if (button) press(button);
  await new Promise((r) => setTimeout(r, 900));
  return null;
`);

socket.close();
console.log(JSON.stringify(report, null, 2));
console.log(
  "PASS: 左上角的笔记图标和 GitHub 图标都是开关——第一次点开标签，再点一次关掉；笔记标签关之前先把内容写盘，重开还在。",
);
process.exit(0);
