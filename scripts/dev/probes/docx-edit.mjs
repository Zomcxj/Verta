// Acceptance for editing a `.docx` in place: type, delete, wait for the save, then read the file back.
//
// The claim is not "the pane shows the new text" - that is the easy half. The claim is that the file
// on disk *is* the edited document, and that everything the edit did not touch is byte-for-byte what
// Word wrote. So the fixture's document part is known exactly, and after the save the part is compared
// against that same string with only the two intended changes applied: the typed text in the first
// paragraph, the deleted paragraph gone. A writer that re-serialized the XML, dropped a run property
// or reordered an attribute fails that comparison without needing to know which byte it moved.
//
// The archive is built here (a ZIP of XML parts, assembled as a folder and zipped by PowerShell), and
// the second part - `word/styles.xml` - exists only to be checked as untouched.
//
// Usage: node scripts/dev/probes/docx-edit.mjs [--port=9222]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const DIR = mkdtempSync(join(tmpdir(), "verta-docx-edit-"));
const FILE = "编辑测试.docx";
const OLD = "Hello old";
const NEW = "Hello new";
const GONE = "Delete me";
const KEPT = "Keep me";
const STYLES = "<w:styles><w:style w:styleId=\"Normal\">keep me byte for byte</w:style></w:styles>";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>${OLD}</w:t></w:r></w:p>
<w:p><w:r><w:t>${GONE}</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${KEPT}</w:t></w:r></w:p>
</w:body></w:document>`;

/** A one-paragraph document, for the Enter case. */
const SPLIT_DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Keep me</w:t></w:r></w:p>
</w:body></w:document>`;
const SPLIT_FILE = "回车测试.docx";

/** Two paragraphs, for the Backspace that joins them. */
const JOIN_DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>alpha</w:t></w:r></w:p>
<w:p><w:r><w:t>beta</w:t></w:r></w:p>
</w:body></w:document>`;
const JOIN_FILE = "退格合并.docx";

/** One paragraph, for Enter at the very end of the document. */
const END_DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>tail</w:t></w:r></w:p>
</w:body></w:document>`;
const END_FILE = "文末回车.docx";

/** Three paragraphs, for a selection that spans them. */
const CROSS_DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>alpha</w:t></w:r></w:p>
<w:p><w:r><w:t>beta</w:t></w:r></w:p>
<w:p><w:r><w:t>gamma</w:t></w:r></w:p>
</w:body></w:document>`;
const CROSS_FILE = "跨段删除.docx";

/** A paragraph, a table, and another paragraph: a table sits between two lines that are both typed in. */
const AFTER_TABLE_DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>before</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>after</w:t></w:r></w:p>
</w:body></w:document>`;
const AFTER_TABLE_FILE = "表格之后.docx";

/** A table above a paragraph: selecting the whole body must not take the table with it. */
const TABLE_DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>under</w:t></w:r></w:p>
</w:body></w:document>`;
const TABLE_FILE = "表格.docx";

const report = {};
// Failures are thrown rather than exited on, so the fixture is removed and the tabs closed on the way
// out.
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page =
  targets.find((t) => t.type === "page" && t.url.endsWith("1420/")) ??
  targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost")) ??
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

/** Hands a path to the app the way an "Open With" does, and waits for its tab to come forward. */
const openedTabs = new Set();
const openFile = async (path, label) => {
  const name = path.split(/[\\/]/).pop();
  const asked = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "verta:open-file", payload: [${JSON.stringify(path)}] }).then(() => true).catch(() => false)`,
  );
  if (!asked) fail(`${label}: the app has no IPC to hand a path to`);
  const active = `([...document.querySelectorAll("[data-tab-id][data-tab-active='true']")][0]?.innerText || "").includes(${JSON.stringify(name)})`;
  if (!(await waitFor(active, 30000))) {
    report.tabs = await evaluate(
      `JSON.stringify([...document.querySelectorAll("[data-tab-id]")].map((el) => (el.innerText || "").trim()))`,
    );
    fail(`${label}: ${name} was handed to the app and its tab never came forward`);
  }
  const tabId = await evaluate(
    `[...document.querySelectorAll("[data-tab-id][data-tab-active='true']")][0]?.getAttribute("data-tab-id") ?? null`,
  );
  if (tabId) openedTabs.add(tabId);
};

/**
 * The document pane on screen.
 *
 * Every open tab's pane stays mounted (the stack keeps them, only hiding the inactive ones), and each
 * of them has paragraphs numbered from zero - so a query by `[data-docx-editable="0"]` without this
 * would type into whichever document happened to be first in the DOM.
 */
const PANE = `[...document.querySelectorAll("[data-docx-preview]")].find((el) => !el.closest('[aria-hidden="true"]'))`;

const cleanup = () => {
  rmSync(DIR, { recursive: true, force: true });
};
process.on("exit", cleanup);


/**
 * Ctrl+Z, as a real key press, with a paragraph focused the way a reader would have it.
 *
 * Nothing here listens for the key itself: the app's global shortcut layer claims Mod+Z in the capture
 * phase and stops the event there, which is exactly why the pane is undone through the shell's
 * `editor.undo` rather than through a listener of its own. So the only honest evidence is the file.
 */
const pressUndo = async () => {
  const focused = await evaluate(`(() => {
    const node = (${PANE})?.querySelector("[data-docx-editable]");
    if (!node) return false;
    // The editable surface is the body: a block inside it is not focusable on its own, and keys go
    // to whatever has the focus.
    (${PANE})?.querySelector("[data-docx-body]")?.focus();
    return true;
  })()`);
  if (!focused) fail("nothing in the document pane could take focus for Ctrl+Z");
  for (const type of ["rawKeyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type,
      modifiers: 2,
      key: "z",
      code: "KeyZ",
      windowsVirtualKeyCode: 90,
      nativeVirtualKeyCode: 90,
    });
    await sleep(60);
  }
};

/** What a carriage return is, without an escape in the source. */
const ENTER_TEXT = String.fromCharCode(13);

/**
 * One real key press: keydown and keyup, as the browser would see it.
 *
 * `text` is what makes Enter edit anything: sent as a raw key-down it is delivered to the page and
 * then ignored by the editor, with no `beforeinput` and no change to the DOM (measured on this
 * WebView2: a plain contenteditable splits on `keyDown` + `text: "
"`, and does nothing on
 * `rawKeyDown`). Backspace and Delete are the other way round - they need no text.
 */
const pressKey = async (key, code, virtualKeyCode, text) => {
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
      ...(type === "keyDown" && text ? { text, unmodifiedText: text } : {}),
    });
    await sleep(60);
  }
};

/** Waits for the pane to finish the save its own handler started. */
const settle = async () => {
  await sleep(900);
  await waitForValue(
    `((${PANE})?.querySelector("[data-docx-save]")?.getAttribute("data-docx-save") ?? "")`,
    (value) => value === "saved" || value === "failed" || value === "stale",
    30000,
  );
  await sleep(600);
};

/** The archive's parts, extracted with PowerShell (Node has no ZIP reader of its own). */
const readParts = (file = FILE) => {
  const out = join(DIR, `unpacked-${file}`);
  rmSync(out, { recursive: true, force: true });
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${join(DIR, file)}', '${out}')`,
    ],
    { stdio: "pipe" },
  );
  return {
    document: readFileSync(join(out, "word", "document.xml"), "utf8"),
    styles: readFileSync(join(out, "word", "styles.xml"), "utf8"),
  };
};

/** Builds a real `.docx` from the parts, under a name of its own. */
function buildArchive(name, document) {
  const staging = join(DIR, `parts-${name}`);
  mkdirSync(join(staging, "_rels"), { recursive: true });
  mkdirSync(join(staging, "word"), { recursive: true });
  writeFileSync(join(staging, "[Content_Types].xml"), CONTENT_TYPES);
  writeFileSync(join(staging, "_rels", ".rels"), RELS);
  writeFileSync(join(staging, "word", "document.xml"), document);
  writeFileSync(join(staging, "word", "styles.xml"), STYLES);
  const zipPath = join(DIR, `${name}.zip`);
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${join(staging, "*")}' -DestinationPath '${zipPath}' -Force`,
    ],
    { stdio: "pipe" },
  );
  const target = join(DIR, name);
  execFileSync(
    "powershell",
    ["-NoProfile", "-Command", `Move-Item -Force '${zipPath}' '${target}'`],
    { stdio: "pipe" },
  );
  return target;
}

/** Walks the editable's text nodes and puts the caret at `offset`. */
const placeCaret = (node, offset) => {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let current = walker.nextNode();
  while (current) {
    if (remaining <= current.textContent.length) {
      const range = document.createRange();
      range.setStart(current, remaining);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }
    remaining -= current.textContent.length;
    current = walker.nextNode();
  }
  return false;
};

try {
  // Editing keys need the window: a blurred page gets the keydown but no default action, so Enter
  // did nothing at all and the probe read a document that had not changed.
  await send("Page.bringToFront");
  const focused = await evaluate(`document.hasFocus()`);
  if (!focused) fail("the window is not focused, so no editing key would reach the document");

  // ---- The fixture: a real archive, assembled as a folder and zipped by PowerShell. ----
  const path = buildArchive(FILE, DOCUMENT);
  report.fixtureDir = DIR;

  const before = readParts();
  if (!before.document.includes(OLD) || !before.document.includes(GONE)) {
    fail("the fixture was not built as expected");
  }

  // ---- Open it and edit the first paragraph ----
  await openFile(path, "the document");
  if (!(await waitFor(`!!(${PANE})?.querySelector("[data-docx-editable]")`, 25000))) {
    report.visible = await evaluate(
      `JSON.stringify([...document.querySelectorAll("div, p")].filter((el) => el.offsetParent !== null && /读不出|只能看|二进制/.test(el.innerText || "")).map((el) => (el.innerText || "").trim()).slice(0, 4))`,
    );
    fail("the document did not open with editable paragraphs");
  }
  report.editableCount = await evaluate(
    `(${PANE})?.querySelectorAll("[data-docx-editable]").length ?? 0`,
  );
  if (report.editableCount !== 3) {
    fail(`the pane offers ${report.editableCount} editable paragraphs, not the three in the file`);
  }

  // Typing, as the pane sees it: the text changes and an `input` event arrives.
  const typed = await evaluate(`(() => {
    const node = (${PANE})?.querySelector('[data-docx-editable="0"]');
    if (!node) return false;
    node.textContent = ${JSON.stringify(NEW)};
    node.dispatchEvent(new InputEvent("input", { bubbles: true }));
    return true;
  })()`);
  if (!typed) fail("the first paragraph could not be typed into");

  // ---- Delete the second one through its own affordance ----
  const deleted = await evaluate(`(() => {
    const button = (${PANE})?.querySelector('[data-docx-delete="1"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!deleted) fail("the second paragraph has no delete affordance");

  // ---- Wait for the save the pane schedules on its own ----
  const saved = await waitForValue(
    `((${PANE})?.querySelector("[data-docx-save]")?.getAttribute("data-docx-save") ?? "")`,
    (value) => value === "saved" || value === "failed" || value === "stale",
    30000,
  );
  report.saveState = saved;
  if (saved !== "saved") {
    report.saveText = await evaluate(
      `((${PANE})?.querySelector("[data-docx-save]")?.innerText || "").trim()`,
    );
    fail(`the pane did not save: ${JSON.stringify(report.saveText)}`);
  }

  // ---- The file on disk is the document ----
  const after = readParts();
  report.documentBytes = { before: before.document.length, after: after.document.length };
  const expected = DOCUMENT.replace(`>${OLD}<`, `>${NEW}<`).replace(
    `<w:p><w:r><w:t>${GONE}</w:t></w:r></w:p>`,
    "",
  );
  report.expectedLength = expected.length;
  if (after.document !== expected) {
    // Say where it first differs: "the part changed" is not actionable, the offset is.
    let at = 0;
    while (at < expected.length && at < after.document.length && expected[at] === after.document[at]) {
      at += 1;
    }
    report.firstDifference = {
      at,
      expected: expected.slice(Math.max(0, at - 40), at + 60),
      got: after.document.slice(Math.max(0, at - 40), at + 60),
    };
    fail(`the document part is not what the edit should have produced (first difference at ${at})`);
  }
  if (after.styles !== STYLES) {
    fail("a part nobody edited was rewritten");
  }

  report.edit = {
    bytes: after.document.length,
    stylesUntouched: after.styles === STYLES,
  };

  // ---- Ctrl+Z takes that back, and takes back *both* changes at once: one save, one step ----
  await pressUndo();
  if (
    !(await waitFor(
      `(${PANE})?.querySelectorAll("[data-docx-editable]").length === 3`,
      25000,
    ))
  ) {
    report.undoAttempt = await evaluate(`(() => {
      const line = (${PANE})?.querySelector("[data-docx-save]");
      return {
        save: line ? { kind: line.getAttribute("data-docx-save"), text: (line.innerText || "").trim() } : null,
        editable: ${PANE} ? ${PANE}.querySelectorAll("[data-docx-editable]").length : null,
        first: (${PANE}?.querySelector('[data-docx-editable="0"]')?.textContent ?? "").slice(0, 40),
        toast: [...document.querySelectorAll("[data-sonner-toast]")].map((node) => (node.innerText || "").replace(/\s+/g, " ").trim().slice(0, 200)),
      };
    })()`);
    fail("Ctrl+Z did not bring the deleted paragraph back");
  }
  await sleep(800);
  const undone = readParts();
  report.undo = { bytes: undone.document.length, restored: undone.document === DOCUMENT };
  if (undone.document !== DOCUMENT) {
    fail("Ctrl+Z did not restore the document part that was there before the change");
  }

  // ---- Enter: the paragraph splits at the caret, and the file gets a second one ----
  const splitPath = buildArchive(SPLIT_FILE, SPLIT_DOCUMENT);
  await openFile(splitPath, "the document to split");
  if (!(await waitFor(`!!(${PANE})?.querySelector('[data-docx-editable="0"]')`, 25000))) {
    fail("the second document did not open as editable");
  }
  const placed = await evaluate(`(() => {
    const node = (${PANE})?.querySelector('[data-docx-editable="0"]');
    if (!node) return false;
    // The editable surface is the body: a block inside it is not focusable on its own, and keys go
    // to whatever has the focus.
    (${PANE})?.querySelector("[data-docx-body]")?.focus();
    return (${placeCaret.toString()})(node, 4);
  })()`);
  if (!placed) fail("the caret could not be placed inside the paragraph");

  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      ...(type === "keyDown" ? { text: ENTER_TEXT, unmodifiedText: ENTER_TEXT } : {}),
    });
  }
  // A split renumbers everything after it, so the pane reads the file again: two editable paragraphs
  // is what "it is done" looks like.
  if (
    !(await waitFor(
      `(${PANE})?.querySelectorAll('[data-docx-editable]').length === 2`,
      25000,
    ))
  ) {
    report.splitState = await evaluate(`(() => {
      const pane = ${PANE};
      return { save: document.querySelector("[data-docx-save]")?.getAttribute("data-docx-save") ?? null, editable: pane ? pane.querySelectorAll("[data-docx-editable]").length : null };
    })()`);
    fail("Enter did not produce a second paragraph");
  }
  await waitForValue(
    `(document.querySelector("[data-docx-save]")?.getAttribute("data-docx-save") ?? "idle")`,
    (value) => value !== "saving",
    15000,
  );
  await sleep(800);

  const split = readParts(SPLIT_FILE);
  const splitExpected = SPLIT_DOCUMENT.replace(
    "<w:p><w:r><w:t>Keep me</w:t></w:r></w:p>",
    '<w:p><w:r><w:t>Keep</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve"> me</w:t></w:r></w:p>',
  );
  report.split = { bytes: split.document.length, expected: splitExpected.length };
  if (split.document !== splitExpected) {
    let at = 0;
    while (
      at < splitExpected.length &&
      at < split.document.length &&
      splitExpected[at] === split.document[at]
    ) {
      at += 1;
    }
    report.splitFirstDifference = {
      at,
      expected: splitExpected.slice(Math.max(0, at - 40), at + 60),
      got: split.document.slice(Math.max(0, at - 40), at + 60),
    };
    fail(`Enter did not write a split paragraph (first difference at ${at})`);
  }

  // ---- And the split is undone the same way: two paragraphs back into one ----
  await pressUndo();
  if (
    !(await waitFor(
      `(${PANE})?.querySelectorAll("[data-docx-editable]").length === 1`,
      25000,
    ))
  ) {
    fail("Ctrl+Z did not put the split paragraph back together");
  }
  await sleep(800);
  const splitUndone = readParts(SPLIT_FILE);
  report.undoSplit = {
    bytes: splitUndone.document.length,
    restored: splitUndone.document === SPLIT_DOCUMENT,
  };
  if (splitUndone.document !== SPLIT_DOCUMENT) {
    fail("Ctrl+Z did not restore the paragraph that was split");
  }

  // ---- Backspace at the start of a line joins it to the one above ----
  const joinPath = buildArchive(JOIN_FILE, JOIN_DOCUMENT);
  await openFile(joinPath, "the document to join");
  if (!(await waitFor(`(${PANE})?.querySelectorAll("[data-docx-editable]").length === 2`, 25000))) {
    fail("the document to join did not open with two paragraphs");
  }
  const atStart = await evaluate(`(() => {
    const node = (${PANE})?.querySelector('[data-docx-editable="1"]');
    if (!node) return false;
    // The editable surface is the body: a block inside it is not focusable on its own, and keys go
    // to whatever has the focus.
    (${PANE})?.querySelector("[data-docx-body]")?.focus();
    return (${placeCaret.toString()})(node, 0);
  })()`);
  if (!atStart) fail("the caret could not be put at the start of the second paragraph");
  await pressKey("Backspace", "Backspace", 8);
  await settle();
  const joined = readParts(JOIN_FILE);
  const joinedExpected = JOIN_DOCUMENT.replace(
    "<w:r><w:t>alpha</w:t></w:r></w:p>",
    "<w:r><w:t>alphabeta</w:t></w:r></w:p>",
  ).replace("<w:p><w:r><w:t>beta</w:t></w:r></w:p>", "");
  // The first paragraph takes the joined text; the second one's element is gone, while the
  // newline that preceded it stays - only the element's bytes are removed.
  report.join = { bytes: joined.document.length, expected: joinedExpected.length };
  if (joined.document !== joinedExpected) {
    report.joinPart = joined.document.slice(0, 400);
    fail("Backspace did not join the two lines");
  }

  // ---- Enter at the very end of the document adds a line that can be typed on ----
  // The case that was dead before: an empty paragraph was dropped on read, so the caret had nowhere
  // to land and the second line could never be written.
  const endPath = buildArchive(END_FILE, END_DOCUMENT);
  await openFile(endPath, "the document to extend");
  if (!(await waitFor(`!!(${PANE})?.querySelector('[data-docx-editable="0"]')`, 25000))) {
    fail("the document to extend did not open");
  }
  const atEnd = await evaluate(`(() => {
    const node = (${PANE})?.querySelector('[data-docx-editable="0"]');
    if (!node) return false;
    // The editable surface is the body: a block inside it is not focusable on its own, and keys go
    // to whatever has the focus.
    (${PANE})?.querySelector("[data-docx-body]")?.focus();
    return (${placeCaret.toString()})(node, node.textContent.length);
  })()`);
  if (!atEnd) fail("the caret could not be put at the end of the last paragraph");
  await pressKey("Enter", "Enter", 13, ENTER_TEXT);
  await sleep(700);
  await send("Input.insertText", { text: "next" });
  await settle();
  const extended = readParts(END_FILE);
  // Structure rather than bytes here: the new paragraph lands right after the first one, so the
  // whitespace around it depends on where the writer sliced, and what matters is the two lines and
  // their text.
  const extendedTexts = [...extended.document.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(
    (match) => match[1],
  );
  const extendedParagraphs = (extended.document.match(/<w:p[ >]/g) ?? []).length;
  report.endEnter = { paragraphs: extendedParagraphs, texts: extendedTexts };
  if (extendedParagraphs !== 2) {
    fail(`Enter at the end of the document left ${extendedParagraphs} paragraphs, not two`);
  }
  if (extendedTexts.join("|") !== "tail|next") {
    fail(`the two lines read ${JSON.stringify(extendedTexts)}, not tail then next`);
  }

  // ---- One deletion across three lines ----
  const crossPath = buildArchive(CROSS_FILE, CROSS_DOCUMENT);
  await openFile(crossPath, "the document to cut across");
  if (!(await waitFor(`(${PANE})?.querySelectorAll("[data-docx-editable]").length === 3`, 25000))) {
    fail("the document to cut across did not open with three paragraphs");
  }
  const selected = await evaluate(`(() => {
    const body = (${PANE})?.querySelector("[data-docx-body]");
    const first = (${PANE})?.querySelector('[data-docx-editable="0"]');
    const last = (${PANE})?.querySelector('[data-docx-editable="2"]');
    if (!body || !first || !last) return false;
    // The blocks carry the delete affordance first, so the text is found by walking: taking the
    // first child would put the range on a button.
    const textIn = (block) => {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      return walker.nextNode();
    };
    const start = textIn(first);
    const end = textIn(last);
    if (!start || !end) return false;
    const range = document.createRange();
    range.setStart(start, 2);
    range.setEnd(end, 2);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    body.focus();
    return true;
  })()`);
  if (!selected) fail("a selection across the three paragraphs could not be made");
  await pressKey("Delete", "Delete", 46);
  await settle();
  const cut = readParts(CROSS_FILE);
  const shown = await evaluate(
    `((${PANE})?.querySelector("[data-docx-body]")?.textContent ?? "").trim()`,
  );
  const paragraphsInCut = cut.document.match(/<w:p[ >]/g) ?? [];
  report.crossDelete = { paragraphs: paragraphsInCut.length, text: shown };
  if (paragraphsInCut.length !== 1) {
    fail(`a deletion across three lines left ${paragraphsInCut.length} paragraphs in the file`);
  }
  if (!cut.document.includes(`<w:t>${shown}</w:t>`)) {
    fail(`the file's one paragraph is not the text the pane shows (${JSON.stringify(shown)})`);
  }

  // ---- A second keystroke after a save in a document that has a table ----
  // The baseline's ordinals come from a read that contains the table; the draft has no table block,
  // because a table cannot be written back. Copied across by index, every paragraph after a table
  // takes its neighbour's ordinal - and once the paragraph that was typed in has none, the next save
  // names nothing at all. The pane still says 已保存 and the second keystroke never reaches the file.
  const afterTablePath = buildArchive(AFTER_TABLE_FILE, AFTER_TABLE_DOCUMENT);
  await openFile(afterTablePath, "the document with a table and a line after it");
  if (!(await waitFor(`!!(${PANE})?.querySelector("[data-docx-body] table")`, 25000))) {
    fail("the document with a table and a line after it did not open");
  }
  const afterTableCaret = await evaluate(`(() => {
    const block = [...((${PANE})?.querySelectorAll("[data-docx-editable]") ?? [])].find(
      (node) => (node.textContent || "").trim() === "after",
    );
    if (!block) return false;
    (${PANE})?.querySelector("[data-docx-body]")?.focus();
    return (${placeCaret.toString()})(block, block.textContent.length);
  })()`);
  if (!afterTableCaret) fail("the caret could not be put at the end of the line after the table");
  await send("Input.insertText", { text: "X" });
  await settle();
  const firstSave = readParts(AFTER_TABLE_FILE);
  if (!firstSave.document.includes("<w:t>afterX</w:t>")) {
    fail(`the first keystroke after the table did not reach the file: ${firstSave.document}`);
  }
  await send("Input.insertText", { text: "Y" });
  await settle();
  const secondSave = readParts(AFTER_TABLE_FILE);
  report.afterTable = {
    first: (firstSave.document.match(/<w:t[^>]*>[^<]*<\/w:t>/g) ?? []).join(" "),
    second: (secondSave.document.match(/<w:t[^>]*>[^<]*<\/w:t>/g) ?? []).join(" "),
  };
  if (!secondSave.document.includes("<w:t>afterXY</w:t>")) {
    fail(`the second keystroke after the table did not reach the file: ${secondSave.document}`);
  }
  if (!secondSave.document.includes("<w:t>before</w:t>") || !secondSave.document.includes("<w:tbl>")) {
    fail(`editing after the table changed something else: ${secondSave.document}`);
  }

  // ---- A table is not deleted by a selection over the whole body ----
  const tablePath = buildArchive(TABLE_FILE, TABLE_DOCUMENT);
  await openFile(tablePath, "the document with a table");
  if (!(await waitFor(`!!(${PANE})?.querySelector("[data-docx-body] table")`, 25000))) {
    fail("the document with a table did not open with the table drawn");
  }
  await evaluate(`(() => {
    const body = (${PANE})?.querySelector("[data-docx-body]");
    const range = document.createRange();
    range.selectNodeContents(body);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    body.focus();
    return true;
  })()`);
  await pressKey("Delete", "Delete", 46);
  await settle();
  const withTable = readParts(TABLE_FILE);
  report.tableKept = withTable.document.includes("<w:tbl>");
  if (!report.tableKept) {
    fail("selecting the whole body and deleting took the table with it");
  }

  report.ok = true;
  console.log(
    `PASS: 就地改了第 1 段、删了第 2 段，并在另一份文档里用回车把一段拆成两段；停手后自动保存，磁盘上的 document.xml 与「原文只做这三处改动」逐字节相同（编辑 ${after.document.length} 字节、拆段 ${split.document.length} 字节），styles.xml 一个字节没动；Ctrl+Z 把「改字+删段」和「回车拆段」都还原成了原样；退格把两段并成一段、文末回车的第二行写得进去、跨段删除只留下一段、整篇删空也不伤表格；表格后面那段存过之后接着再打一个字，第二个字也进了文件（没有被序号错位吞掉）。`,
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    `FAIL: ${error instanceof ProbeFailure ? error.message : String(error?.message ?? error)}`,
  );
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  // Only the tabs this run opened, and only through their own close chip.
  try {
    await evaluate(`(() => {
      const ids = ${JSON.stringify([...openedTabs])};
      let closed = 0;
      for (const el of document.querySelectorAll("[data-tab-id]")) {
        if (!ids.includes(el.getAttribute("data-tab-id"))) continue;
        const chip = el.querySelector('[role="button"]');
        if (chip) {
          chip.click();
          closed += 1;
        }
      }
      return closed;
    })()`);
    await sleep(600);
  } catch {
    // A dead webview still leaves the directory removed below, which is the part that matters.
  }
  cleanup();
  socket.close();
}
