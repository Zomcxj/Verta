// Acceptance for the audit's sixth finding: "the Markdown side preview renders a stale snapshot".
//
// The finding was measured at source level (the buffer read `# New title` while the preview prop
// still held `# Old title`); what this asks is the same question of the running app, through the
// pixels and the DOM: open a Markdown file, open its side preview, type a new heading, and read what
// the preview column now draws. Before the fix the column kept drawing the text the file was loaded
// with, so the heading would still be the old one.
//
// Two directions are checked, because "the preview shows the typed text" alone would pass if the
// preview simply accumulated both: the new heading has to be there *and* the old one has to be gone.
//
// The fixture is created and removed by this probe, in a directory of its own under the explorer
// root, so nothing else in the workspace is touched. Usage:
//   node scripts/dev/probes/markdown-preview-follows-typing.mjs [--port=9222]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const DIR = "preview-probe-tmp";
/** A name unique to this run: an earlier run's file cannot be left open in a tab and be mistaken
 *  for the one just opened, which the first version of this probe did (its source pane belonged to
 *  a leftover tab while the tab that had just opened was showing the rendered view). */
const FILE = `note-${Math.random().toString(36).slice(2, 8)}.md`;
const ON_DISK = "# Old title\n\nfirst paragraph\n";
/** The same document with a new heading: what the typing replaces the buffer with. */
const NEW_DOC = "# New title\n\nfirst paragraph\n";

const report = {};
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  console.error(JSON.stringify(report, null, 2));
  cleanup();
  process.exit(1);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page =
  targets.find((t) => t.type === "page" && t.url.endsWith("1420/")) ??
  targets.find((t) => t.type === "page");
if (!page) {
  console.error("dev 起来了？没找到主窗口的 page 目标。");
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
    const what = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`${what} in: ${expression.slice(0, 200)}`);
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
const realClick = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sleep(30);
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
};
const waitFor = async (expression, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`(() => { const n = ${expression}; return n ? true : false; })()`)) {
      return true;
    }
    await sleep(250);
  }
  return false;
};
const clickOn = async (expression, label, timeoutMs = 30000) => {
  if (!(await waitFor(expression, timeoutMs))) fail(`could not find ${label}`);
  await sleep(200);
  const rect = await rectOf(expression);
  if (!rect) fail(`${label} has no box to click`);
  await realClick(rect.x, rect.y);
  return rect;
};

/** Editor DOM is queried only inside the pane that is not hidden: every open editor stays mounted,
 *  so the first match in the document can belong to a tab that is not on screen. */
const VISIBLE = (selector) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => !el.closest('[aria-hidden="true"]'))`;

let rootDir = null;
const cleanup = () => {
  if (rootDir) rmSync(join(rootDir, DIR), { recursive: true, force: true });
};
process.on("exit", cleanup);

try {
  // ---- The explorer's root: the parent of a depth-0 row (padding 6px is depth 0). The sidebar may
  // be collapsed or showing the sessions list, which is one click away, in that order. ----
  const topRowExpr = `(() => {
    const row = [...document.querySelectorAll("[data-fs-path]")].find((r) => r.style.paddingLeft === "6px");
    return row ? row.getAttribute("data-fs-path") : null;
  })()`;
  const waitForValue = async (expression, predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await evaluate(expression);
      if (predicate(last)) return last;
      await sleep(250);
    }
    return last;
  };
  let topRow = await waitForValue(
    topRowExpr,
    (v) => typeof v === "string" && v.length > 1,
    4000,
  );
  if (!topRow) {
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
    topRow = await waitForValue(
      topRowExpr,
      (v) => typeof v === "string" && v.length > 1,
      20000,
    );
  }
  if (!topRow) fail("no row in the file tree: is the sidebar showing the tree?");
  const topName = topRow.split(/[\\/]/).pop();
  rootDir = topRow.slice(0, topRow.length - topName.length - 1);
  report.explorerRoot = rootDir;
  console.log(`explorer root: ${rootDir}`);

  // ---- The fixture ----
  mkdirSync(join(rootDir, DIR), { recursive: true });
  writeFileSync(join(rootDir, DIR, FILE), ON_DISK);
  const rowExpr = (name) =>
    `[...document.querySelectorAll("button[data-fs-path]")].find((r) => (r.getAttribute("data-fs-path") || "").endsWith(${JSON.stringify(name)}))`;
  if (!(await waitFor(rowExpr(DIR), 30000))) fail(`the tree never showed ${DIR}`);
  await clickOn(rowExpr(DIR), `${DIR} in the tree`);
  if (!(await waitFor(rowExpr(FILE), 20000))) fail(`the tree never showed ${FILE}`);
  await clickOn(rowExpr(FILE), `${FILE} in the tree`);
  // The tab that must be showing it: a leftover tab of another file can hold the DOM query that
  // follows, so the active tab is checked rather than assumed.
  const activeTabExpr = `([...document.querySelectorAll("[data-tab-id][data-tab-active='true']")][0]?.innerText || "").trim()`;
  report.activeTab = await waitForValue(
    activeTabExpr,
    (v) => typeof v === "string" && v.includes(FILE),
    15000,
  );
  if (!(report.activeTab ?? "").includes(FILE)) {
    await clickOn(
      `[...document.querySelectorAll("[data-tab-id]")].find((el) => (el.innerText || "").includes(${JSON.stringify(FILE)}))`,
      `the tab for ${FILE}`,
      8000,
    );
    report.activeTab = await waitForValue(
      activeTabExpr,
      (v) => typeof v === "string" && v.includes(FILE),
      8000,
    );
  }
  if (!(report.activeTab ?? "").includes(FILE)) {
    fail(`the tab on screen is not the file that was opened (saw ${JSON.stringify(report.activeTab)})`);
  }

  // A Markdown file can open in the rendered view, where there is no text area to type into; the
  // source stop of the editor's own three-way control is what brings CodeMirror back. It is also the
  // stop that must exist for the preview stop to be drawn at all (the rendered view has two stops).
  const visibleButton = (pattern) =>
    `[...document.querySelectorAll("button")].filter((b) => !b.closest('[aria-hidden="true"]')).find((b) => ${pattern}.test((b.innerText || "").trim()))`;
  const rawStop = visibleButton(`/^(源码|Raw)$/`);
  if (await waitFor(rawStop, 5000)) {
    await clickOn(rawStop, "the source stop of the markdown control", 8000);
  }
  report.editorIsSource = await waitFor(`!!(${VISIBLE(".cm-content")})`, 15000);
  if (!report.editorIsSource) fail("the file never reached a source editor");

  // ---- The side preview, through the editor's own three-way control ----
  const previewStop = visibleButton(`/^(预览|Preview)$/`);
  if (!(await waitFor(previewStop, 12000))) {
    report.buttons = await evaluate(
      `JSON.stringify([...document.querySelectorAll("button")].map((b) => (b.innerText || "").trim()).filter(Boolean).slice(0, 40))`,
    );
    report.activeTab = await evaluate(
      `([...document.querySelectorAll("[data-tab-id][data-tab-active='true']")][0]?.innerText || "").trim()`,
    );
    fail("could not find the preview stop of the markdown control");
  }
  await clickOn(previewStop, "the preview stop of the markdown control", 5000);
  report.previewOpen = await waitFor(
    `!!(${VISIBLE('[data-side-preview][data-state="open"]')})`,
    10000,
  );
  if (!report.previewOpen) fail("the side preview never opened");
  const previewText = () =>
    evaluate(`(() => {
      const pane = ${VISIBLE('[data-side-preview][data-state="open"] .markdown-rendered')};
      return pane ? (pane.innerText || "").replace(/\\s+/g, " ").trim() : null;
    })()`);
  for (let i = 0; i < 40 && (await previewText()) === null; i++) await sleep(250);
  report.previewBefore = await previewText();
  console.log(`preview before typing: ${JSON.stringify(report.previewBefore)}`);

  // ---- Type into the editor, the way a person does: replace the whole document with the same
  // file carrying a new heading. Replacing (rather than appending) is what makes the second half of
  // the check mean something - a preview that merely accumulates text would pass on the first half
  // alone. ----
  await clickOn(`${VISIBLE(".cm-content")}`, "the editor's text area");
  await sleep(300);
  for (const type of ["rawKeyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type,
      key: "a",
      code: "KeyA",
      modifiers: 2,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
    });
  }
  await sleep(300);
  await send("Input.insertText", { text: NEW_DOC });
  await sleep(1500);
  report.editorText = await evaluate(
    `((${VISIBLE(".cm-content")}?.innerText) || "").replace(/\\s+/g, " ").trim()`,
  );
  report.previewAfter = await previewText();
  console.log(`editor now:            ${JSON.stringify(report.editorText)}`);
  console.log(`preview after typing:  ${JSON.stringify(report.previewAfter)}`);

  const typed = (report.previewAfter ?? "").includes("New title");
  const stale = (report.previewAfter ?? "").includes("Old title");
  report.previewFollowed = typed;
  report.previewKeptOld = stale;
  if (!(report.editorText ?? "").includes("New title")) {
    fail("the editor did not take the typing, so this run says nothing about the preview");
  }
  if (!typed) fail("the preview does not draw the heading that was just typed");
  if (stale) fail("the preview still draws the heading the document had before the typing");

  // ---- With the preview shut, it must not be redrawn for the typing either ----
  await clickOn(rowExpr(FILE), `${FILE} again`, 10000).catch(() => null);
  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  fail(String(error.message ?? error));
} finally {
  // The editor tab of the fixture is closed before the fixture goes, so no tab is left on a file
  // that has been deleted.
  try {
    await evaluate(`(() => {
      const ours = ${JSON.stringify(DIR)};
      const tabs = [...document.querySelectorAll("[data-tab-id]")].filter((el) => (el.innerText || "").includes(ours) || (el.innerText || "").includes(${JSON.stringify(FILE)}));
      for (const tab of tabs) {
        const chip = tab.querySelector('[role="button"][aria-label]');
        if (chip && /关闭标签页|Close tab/.test(chip.getAttribute("aria-label") || "")) chip.click();
      }
      return tabs.length;
    })()`);
    await sleep(600);
  } catch {
    // A dead webview still leaves the fixture removed below, which is the part that matters.
  }
  cleanup();
  console.log(`fixture removed: ${join(rootDir ?? "?", DIR)}`);
  socket.close();
}
