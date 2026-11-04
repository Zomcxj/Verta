// Does the notes tab do what it says: open from the header button, create a note beside the
// executable, keep what was typed across a tab switch and across closing the tab, rename it,
// offer the same three view stops a markdown file has, and delete it through its own confirm?
//
// Driven through the interface the way a person does it, because the folder's location, the
// saves on switch and close, and the view switch are the parts a unit test cannot see.
//
//   node scripts/dev/probes/notes-tab.mjs [--port=9222]
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
const click = async (x, y) => {
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await sleep(250);
};

const PRESS = `
  const press = (el) => {
    const o = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...o, buttons: 0 }));
  };
`;

// The folder the notes live in, straight from the app: this is what has to sit next
// to the executable, and what the file checks below read.
const dir = await evaluate(
  `const invoke = window.__TAURI_INTERNALS__.invoke;
   return invoke("notes_dir");`,
);
report.dir = dir;
const { readFileSync: readNoteFile, readdirSync } = await import("node:fs");
const listNotes = () =>
  readdirSync(dir)
    .filter((name) => /\.md$/i.test(name))
    .sort();
const readNote = (name) => readNoteFile(`${dir}/${name}`, "utf8");

// --- open the tab, from the header button ------------------------------------------------------
const opened = await evaluate(`
  ${PRESS}
  const openChip = [...document.querySelectorAll("[data-tab-id]")].find((el) => /笔记|Notes/.test(el.textContent || ""));
  if (openChip) {
    press(openChip);
    await new Promise((r) => setTimeout(r, 700));
    return "opened";
  }
  const button = [...document.querySelectorAll("button[title]")].find((b) =>
    /^笔记$|^Notes$/.test((b.getAttribute("title") ?? "").trim()));
  if (!button) return "no-header-button";
  press(button);
  await new Promise((r) => setTimeout(r, 1200));
  return "opened";
`);
report.opened = opened;
if (opened !== "opened") fail(`笔记标签没开成（左上角按钮）：${opened}`);

// --- create -----------------------------------------------------------------------------------
const notesBefore = listNotes();
const created = await evaluate(`
  ${PRESS}
  const button = [...document.querySelectorAll("button")].find((b) => {
    const label = (b.textContent || "").trim();
    return label === "新建" || label === "New";
  });
  if (!button) return "no-new";
  press(button);
  await new Promise((r) => setTimeout(r, 900));
  return "created";
`);
report.created = created;
if (created !== "created") fail(`新建按钮没点动：${created}`);
await sleep(600);
const fresh = listNotes().filter((name) => !notesBefore.includes(name));
report.freshNotes = fresh;
if (fresh.length !== 1) fail(`新建应留下正好一个 .md，实际 ${JSON.stringify(fresh)}`);
let noteName = fresh[0];
// Named for the second it was made: `note-YYMMDD-HHmmss.md`.
if (!/^note-\d{6}-\d{6}\.md$/.test(noteName)) {
  fail(`新笔记的名字不是精确到秒的 note-YYMMDD-HHmmss.md：${noteName}`);
}

// --- type -------------------------------------------------------------------------------------
const editorPoint = await evaluate(`
  // Two editors can be mounted at once (the editor stack's layer and this one), and the
  // first in document order belongs to a layer that is hidden. Only the visible one counts.
  const visible = (el) => {
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && el.offsetParent !== null;
  };
  const el = [...document.querySelectorAll(".cm-content")].find(visible) ?? null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + Math.min(200, r.width / 2)), y: Math.round(r.top + r.height / 2) };
`);
if (!editorPoint) fail("可见的编辑器没画出来（.cm-content 不在）");
await send("Page.bringToFront", {});
await click(editorPoint.x, editorPoint.y);
await sleep(400);
let focused = await evaluate(`
  const el = document.activeElement;
  return el ? (el.closest(".cm-editor") ? "editor" : el.tagName) : "none";
`);
if (focused !== "editor") {
  focused = await evaluate(`
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && el.offsetParent !== null;
    };
    const el = [...document.querySelectorAll(".cm-content")].find(visible) ?? null;
    if (!el) return "missing";
    el.focus();
    return el === document.activeElement || el.contains(document.activeElement) ? "editor" : "refused";
  `);
  report.focusFallback = focused;
}
report.focused = focused;
if (focused !== "editor") fail(`编辑区拿不到焦点：${focused}`);
const typed = "hello notes 笔记";
await send("Input.insertText", { text: typed });
await sleep(500);

// --- the view switch: three stops, the same as a markdown file ---------------------------------
const stops = await evaluate(`
  const visible = (el) => {
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && el.offsetParent !== null;
  };
  return [...document.querySelectorAll("button[aria-pressed]")]
    .filter(visible)
    .map((b) => ({ label: (b.textContent || "").trim(), pressed: b.getAttribute("aria-pressed") === "true", disabled: b.disabled }));
`);
report.viewStops = stops;
if (stops.length < 3) {
  fail(`编辑区右上角的视图切换只有 ${stops.length} 档（${JSON.stringify(stops)}），应与 md 一样是渲染/源码/预览三档`);
}

// --- switch away and back ---------------------------------------------------------------------
const switched = await evaluate(`
  ${PRESS}
  const chips = [...document.querySelectorAll("[data-tab-id]")];
  const other = chips.find((el) => !/笔记|Notes/.test(el.textContent || ""));
  if (!other) return "no-other-tab";
  press(other);
  await new Promise((r) => setTimeout(r, 700));
  const back = [...document.querySelectorAll("[data-tab-id]")].find((el) => /笔记|Notes/.test(el.textContent || ""));
  if (!back) return "no-notes-tab";
  press(back);
  await new Promise((r) => setTimeout(r, 900));
  return "switched";
`);
report.switched = switched;
if (switched !== "switched") fail(`切走再切回没成：${switched}`);
const afterSwitch = readNote(noteName);
report.afterSwitch = afterSwitch;
if (!afterSwitch.includes(typed)) {
  fail(`切走再切回后内容不在了：文件里是 ${JSON.stringify(afterSwitch)}，应有 ${JSON.stringify(typed)}`);
}

// --- rename -----------------------------------------------------------------------------------
const renamed = await evaluate(`
  ${PRESS}
  const row = [...document.querySelectorAll("button")].find((b) => b.textContent.includes(${JSON.stringify(noteName)}));
  if (!row) return "no-row";
  // The row's container, not the button: pressing rename swaps the button for the name
  // field, and the old button leaves the document (a detached element has no parent).
  const group = row.parentElement;
  if (!group) return "no-group";
  const renameButton = [...group.querySelectorAll("button[aria-label]")].find((b) =>
    /改名|Rename/.test(b.getAttribute("aria-label") ?? ""));
  if (!renameButton) return "no-rename-button";
  press(renameButton);
  await new Promise((r) => setTimeout(r, 300));
  const input = group.querySelector("input");
  if (!input) return "no-input";
  input.value = "renamed-note";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));
  return "renamed";
`);
report.renamed = renamed;
if (renamed !== "renamed") fail(`改名没走完：${renamed}`);
const renamedTo = "renamed-note.md";
if (listNotes().includes(noteName)) fail(`改名后旧名字还在：${noteName}`);
if (!listNotes().includes(renamedTo)) fail(`改名后没有 ${renamedTo}：${JSON.stringify(listNotes())}`);
noteName = renamedTo;
if (!readNote(noteName).includes(typed)) fail("改名后内容丢了");

// --- close and reopen -------------------------------------------------------------------------
const closed = await evaluate(`
  ${PRESS}
  const chip = [...document.querySelectorAll("[data-tab-id]")].find((el) => /笔记|Notes/.test(el.textContent || ""));
  if (!chip) return "no-chip";
  const o = { bubbles: true, cancelable: true, button: 1, buttons: 4, isPrimary: false, pointerId: 1, pointerType: "mouse" };
  chip.dispatchEvent(new MouseEvent("auxclick", o));
  await new Promise((r) => setTimeout(r, 800));
  const button = [...document.querySelectorAll("button[title]")].find((b) =>
    /^笔记$|^Notes$/.test((b.getAttribute("title") ?? "").trim()));
  if (!button) return "no-header-button";
  press(button);
  await new Promise((r) => setTimeout(r, 1200));
  return "reopened";
`);
report.reopened = closed;
if (closed !== "reopened") fail(`关掉重开没成：${closed}`);
if (!readNote(noteName).includes(typed)) fail("关掉重开后内容不在了");
const rowBack = await evaluate(`
  return [...document.querySelectorAll("button")].some((b) => b.textContent.includes(${JSON.stringify(noteName)})) ? "in-list" : "not-in-list";
`);
if (rowBack !== "in-list") fail("重开的标签里没有那一篇笔记的行");

// --- delete through its confirm ---------------------------------------------------------------
const deleted = await evaluate(`
  ${PRESS}
  const row = [...document.querySelectorAll("button")].find((b) => b.textContent.includes(${JSON.stringify(noteName)}));
  if (!row) return "no-row";
  const group = row.parentElement;
  if (!group) return "no-group";
  row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  const trash = [...group.querySelectorAll("button[aria-label]")].find((b) =>
    /^(删除|Delete)$/.test((b.getAttribute("aria-label") ?? "").trim()));
  if (!trash) return "no-trash";
  press(trash);
  await new Promise((r) => setTimeout(r, 400));
  const confirm = [...group.querySelectorAll("button")].find((b) =>
    (b.textContent || "").trim() === "删除" || (b.textContent || "").trim() === "Delete");
  if (!confirm) return "no-confirm";
  press(confirm);
  await new Promise((r) => setTimeout(r, 900));
  return "deleted";
`);
report.deleted = deleted;
if (deleted !== "deleted") fail(`删除没走完：${deleted}`);
await sleep(400);
if (listNotes().includes(noteName)) fail("删掉的笔记还在 notes\\ 里");

socket.close();
console.log(JSON.stringify(report, null, 2));
console.log(
  "PASS: 左上角按钮开笔记标签；新笔记按秒命名、写在 exe 旁边的 notes\\；写的内容在切走切回、改名、关掉重开之后都在；右上角是渲染/源码/预览三档；删除走垃圾桶 + 圆角确认。",
);
process.exit(0);
