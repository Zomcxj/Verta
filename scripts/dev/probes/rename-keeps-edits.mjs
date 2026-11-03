// Acceptance for "renaming a file in the tree keeps the editor's unsaved edits": the file is
// opened, typed into, renamed through the tree's own double-click-to-rename flow, and then saved.
//
// Before the fix the rename ran the open-another-file path: `onPathRenamed` gave the tab a new
// path, `useDocument`'s load effect fired, cleared the unsaved flag and replaced the buffer with
// what the new name held on disk - so everything typed was gone by the time the rename settled.
// The three checks that would have caught it:
//   1. the buffer still holds the typed text after the rename,
//   2. the tab still carries its unsaved dot,
//   3. saving writes the typed text to the NEW path and nothing is left at the old one.
//
// The fixture is created and removed by this probe, inside a directory of its own under the
// explorer root, so nothing else in the workspace is touched.
//
// Usage: node scripts/dev/probes/rename-keeps-edits.mjs [--port=9222]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";

const DIR = "rename-probe-tmp";
const OLD_NAME = "before.txt";
const NEW_NAME = "after.txt";
const ON_DISK = "line one on disk\nline two on disk\n";
const TYPED = "TYPED_BY_PROBE";

const report = {};
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("no page target; is the dev instance up?");
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
await new Promise((resolve, reject) => {
  socket.addEventListener("open", () => resolve());
  socket.addEventListener("error", (e) => reject(new Error(String(e.message ?? e))));
});
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
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "exception in page",
    );
  }
  return result.result.value;
};

const rectOf = (expression) =>
  evaluate(`(() => {
    const node = ${expression};
    if (!node) return null;
    const r = node.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  })()`);

/** A real mouse click: WebView2 only fires React onClick for synthesized input carrying `buttons`. */
const realClick = async (x, y, clickCount = 1) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  for (let i = 1; i <= clickCount; i += 1) {
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: i,
    });
    await sleep(30);
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: i,
    });
    if (i < clickCount) await sleep(40);
  }
};

const waitFor = async (expression, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(`(() => { const n = ${expression}; return n ? true : false; })()`);
    if (value) return true;
    await sleep(250);
  }
  return false;
};

const waitForValue = async (expression, predicate = (v) => v !== null, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(expression);
    if (predicate(last)) return last;
    await sleep(250);
  }
  return last;
};

const clickOn = async (expression, label, timeoutMs = 30000) => {
  const found = await waitFor(expression, timeoutMs);
  if (!found) fail(`could not find ${label}`);
  await sleep(200);
  const rect = await rectOf(expression);
  if (!rect) fail(`${label} has no box to click`);
  await realClick(rect.x, rect.y);
  return rect;
};

/** React tracks the value on the DOM node, so a plain `node.value = x` is ignored. */
const setValue = (selectorExpression, value) =>
  evaluate(`(() => {
    const node = ${selectorExpression};
    if (!node) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(node, ${JSON.stringify(value)});
    node.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);

const pressKey = async (key, code, keyCode, modifiers = 0) => {
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
  }
};

const rowExpr = (name) =>
  `[...document.querySelectorAll("[data-fs-path]")].find((r) => (r.getAttribute("data-fs-path") || "").split(/[\\\\/]/).pop() === ${JSON.stringify(name)})`;

const editorTextExpr = `document.querySelector(".cm-content")`;
const bufferExpr = `(() => { const n = ${editorTextExpr}; return n ? n.innerText : null; })()`;
const dirtyDotExpr = `[...document.querySelectorAll("[data-tab-id]")].find((t) => /有未保存的更改|Unsaved changes/.test(t.innerHTML))`;
const activeTabLabelExpr = `(() => {
  const t = document.querySelector('[data-tab-id][data-tab-active="true"]');
  if (!t) return null;
  return (t.innerText || "").trim();
})()`;

/** Insert at the caret the way a paste would; fall back to per-character key events. */
const typeIntoEditor = async (text) => {
  const before = await evaluate(bufferExpr);
  try {
    await send("Input.insertText", { text });
  } catch {
    /* fall through to the key events below */
  }
  let after = await evaluate(bufferExpr);
  if (after !== before && after?.includes(text)) return "insertText";
  for (const ch of text) {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      text: ch,
      unmodifiedText: ch,
      key: ch,
    });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
  }
  after = await evaluate(bufferExpr);
  return after?.includes(text) ? "keyEvents" : "none";
};

let root = null;
let cleanupDir = null;

try {
  const booted = await waitFor(`document.querySelectorAll("button").length > 3`, 120000);
  if (!booted) fail("the window never rendered");
  await sleep(1200);

  // ---- 0. The explorer's root, read off a top-level row (paddingLeft 6px is depth 0) ----
  const topRowExpr = `(() => {
    const row = [...document.querySelectorAll("[data-fs-path]")].find((r) => r.style.paddingLeft === "6px");
    return row ? row.getAttribute("data-fs-path") : null;
  })()`;
  let topRow = await waitForValue(topRowExpr, (v) => typeof v === "string" && v.length > 1, 4000);
  if (!topRow) {
    // The sidebar may be collapsed or showing the sessions list rather than the tree. Both are one
    // click away, in that order: the rail is only on screen while the sidebar is open, so the rail
    // is looked for first - clicking the toggle on an open sidebar would close it.
    const filesTab = `[...document.querySelectorAll("button")].find((b) => /^(文件|Files)$/.test((b.getAttribute("aria-label") || "").trim()))`;
    if (!(await waitFor(filesTab, 2000))) {
      const toggle = `[...document.querySelectorAll("button")].find((b) => /显示\\/隐藏侧栏|Toggle sidebar/.test((b.getAttribute("title") || "") + (b.getAttribute("aria-label") || "")))`;
      if (await waitFor(toggle, 5000)) {
        await clickOn(toggle, "the sidebar toggle");
        await sleep(900);
      }
    }
    if (await waitFor(filesTab, 8000)) {
      await clickOn(filesTab, "the files tab in the sidebar rail");
      await sleep(1200);
    }
    topRow = await waitForValue(topRowExpr, (v) => typeof v === "string" && v.length > 1, 20000);
  }
  if (!topRow) fail("no top-level row in the explorer: is the sidebar showing the file tree?");
  const name = topRow.split(/[\\/]/).pop();
  root = topRow.slice(0, topRow.length - name.length - 1);
  report.root = root;

  // ---- 1. Fixture, then wait for the tree to pick it up ----
  cleanupDir = join(root, DIR);
  mkdirSync(cleanupDir, { recursive: true });
  writeFileSync(join(cleanupDir, OLD_NAME), ON_DISK);
  const folderRow = `[...document.querySelectorAll("[data-fs-path]")].find((r) => (r.getAttribute("data-fs-path") || "").endsWith(${JSON.stringify(`/${DIR}`)}))`;
  if (!(await waitFor(folderRow, 30000))) fail(`the tree never showed ${DIR}`);
  await clickOn(folderRow, `${DIR} on the tree`);
  const oldRow = rowExpr(OLD_NAME);
  if (!(await waitFor(oldRow, 20000))) fail(`the tree never showed ${OLD_NAME}`);

  // ---- 2. Open it and type into it ----
  await clickOn(oldRow, `${OLD_NAME} on the tree`);
  if (!(await waitFor(editorTextExpr, 20000))) fail("the editor never opened the file");
  const opened = await waitForValue(bufferExpr, (v) => typeof v === "string" && v.includes("line one on disk"), 20000);
  if (!opened?.includes("line one on disk")) fail(`the editor did not show the file's text (saw ${JSON.stringify(opened)})`);
  report.textAfterOpen = opened.replace(/\s+/g, " ").trim();

  const editorRect = await rectOf(editorTextExpr);
  await realClick(editorRect.x, editorRect.y);
  await sleep(300);
  report.typedWith = await typeIntoEditor(TYPED);
  if (report.typedWith === "none") fail("could not get text into the editor");
  const typedBuffer = await evaluate(bufferExpr);
  if (!typedBuffer.includes(TYPED)) fail("the typed text is not in the buffer");
  if (!(await waitFor(dirtyDotExpr, 10000))) fail("typing did not mark the tab unsaved");

  // ---- 3. Rename it through the tree ----
  const rowRect = await rectOf(oldRow);
  await realClick(rowRect.x, rowRect.y, 2);
  const inputExpr = `[...document.querySelectorAll("input")].find((i) => i.value === ${JSON.stringify(OLD_NAME)})`;
  if (!(await waitFor(inputExpr, 15000))) fail("double-click did not open the rename input");
  await setValue(inputExpr, NEW_NAME);
  await pressKey("Enter", "Enter", 13);

  // ---- 4. The assertions the fix is about ----
  const renamedLabel = await waitForValue(activeTabLabelExpr, (v) => typeof v === "string" && v.includes(NEW_NAME), 20000);
  report.tabLabelAfterRename = renamedLabel;
  if (!renamedLabel || !renamedLabel.includes(NEW_NAME)) fail(`the tab did not follow the new name (saw ${JSON.stringify(renamedLabel)})`);

  const bufferAfter = await evaluate(bufferExpr);
  report.bufferHasTypedAfterRename = bufferAfter?.includes(TYPED) ?? false;
  report.bufferAfterRename = (bufferAfter ?? "").replace(/\s+/g, " ").trim();
  if (!report.bufferHasTypedAfterRename) {
    fail("the rename replaced the buffer: the unsaved text is gone");
  }
  report.dirtyDotAfterRename = await waitFor(dirtyDotExpr, 5000);
  if (!report.dirtyDotAfterRename) fail("the rename cleared the unsaved mark");

  // ---- 5. Save: the text must land at the new path, and nothing at the old one ----
  await pressKey("s", "KeyS", 83, 2); // Ctrl
  await sleep(1800);
  const newFile = join(cleanupDir, NEW_NAME);
  const oldFile = join(cleanupDir, OLD_NAME);
  report.savedText = (() => {
    try {
      return readFileSync(newFile, "utf8");
    } catch {
      return null;
    }
  })();
  report.oldFileGone = (() => {
    try {
      readFileSync(oldFile, "utf8");
      return false;
    } catch {
      return true;
    }
  })();
  if (report.savedText === null || !report.savedText.includes(TYPED)) {
    fail(`saving did not write the typed text to ${NEW_NAME} (saw ${JSON.stringify(report.savedText)})`);
  }
  if (!report.oldFileGone) fail(`${OLD_NAME} still exists; the save went to the old path`);

  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  fail(String(error?.message ?? error));
} finally {
  if (cleanupDir) {
    try {
      rmSync(cleanupDir, { recursive: true, force: true });
      report.fixtureRemoved = true;
    } catch (e) {
      report.fixtureRemoved = String(e?.message ?? e);
    }
  }
  socket.close();
}
