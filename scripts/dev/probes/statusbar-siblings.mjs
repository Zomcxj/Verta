// Acceptance for the status bar's path: a segment can be clicked to move to a folder **beside** it,
// and a working directory only the shell could name is shown as the Windows path it is.
//
// The trail used to go one way only - down, into the folder a segment names - so moving to the folder
// next to it meant going into this one and back up. Every segment now carries the subfolders of its
// parent (a caret beside the segment), and the folder you are in lists them too, under the children.
//
// The folder the shell is moved to is spelled the way Git-Bash spells it (`/tmp/<fixture>`, which is
// the user's temp directory), because that is the spelling the shell reports over OSC 7 and the one
// nothing on the Windows side can open: `list_subdirs` answers 系统找不到指定的路径. The app asks the
// shell itself (`cygpath -w`) and shows the answer, so what is asserted first is that the trail shows
// the Windows path while the shell is standing in the MSYS one.
//
// The terminal is opened by the product's own Ctrl+T rather than by `pty_open`: a session opened the
// raw way has no receiver on the page, so its shell's OSC 7 never reaches the window and the status
// bar cannot follow it at all. The fixture folder and the tab are removed at the end.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/statusbar-siblings.mjs [--port=9222]
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";

// A tree with two folders beside the one the terminal starts in, and one inside it, so the menu has
// something to get right in both directions.
const ROOT = mkdtempSync(join(tmpdir(), "verta-crumb-"));
const INSIDE = join(ROOT, "inside");
const DEEPER = join(INSIDE, "deeper");
const BESIDE = join(ROOT, "sibling-a");
const OTHER = join(ROOT, "sibling-b");
for (const folder of [INSIDE, DEEPER, BESIDE, OTHER]) mkdirSync(folder, { recursive: true });

// Windows paths reach the app with backslashes; the breadcrumb normalizes them to a forward slash,
// so the attributes carry that spelling.
const asPosix = (path) => path.replace(/\\/g, "/");

const report = {};
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
// The main window, not whichever page carries the app's origin: a settings window is a page of the
// same origin and has none of the tab strip this probe drives.
const page =
  targets.find((t) => t.type === "page" && t.url === "http://tauri.localhost/") ??
  targets.find((t) => t.type === "page" && t.url.endsWith("1420/")) ??
  targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost")) ??
  targets.find((t) => t.type === "page");
if (!page) fail("no page target: is the app running with --remote-debugging-port?");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve);
  socket.addEventListener("error", (e) => reject(new Error(String(e?.message ?? e))));
});
let nextId = 1;
const pending = new Map();
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
      `${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text} in: ${expression.slice(0, 200)}`,
    );
  }
  return result.result.value;
};
const waitFor = async (expression, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`(() => { const value = ${expression}; return value ? true : false; })()`)) {
      return true;
    }
    await sleep(200);
  }
  return false;
};

/**
 * The tabs that are open now.
 *
 * A probe must not close every tab it finds: the session it was run in is the user's, and the tabs
 * already open are theirs. Only the difference between two of these is the probe's to close.
 */
const tabIds = async () =>
  new Set(
    JSON.parse(
      (await evaluate(
        `JSON.stringify([...document.querySelectorAll("[data-tab-id]")].map((el) => el.getAttribute("data-tab-id")))`,
      )) || "[]",
    ),
  );

/** How a chip is pressed. The app's tab strip reacts to a press, not to a click. */
const PRESS = `const press = (node) => {
  const options = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
  node.dispatchEvent(new PointerEvent("pointerdown", options));
  node.dispatchEvent(new PointerEvent("pointerup", { ...options, buttons: 0 }));
  node.dispatchEvent(new MouseEvent("click", { ...options, buttons: 0 }));
};`;

/**
 * Close the named tabs, each through its own close chip.
 *
 * The chip is a `span[role=button]` inside the tab trigger, and a bare `click` on it does nothing:
 * a press - `pointerdown`, `pointerup`, then `click` - is what the strip listens for. It is the last
 * labelled control in a tab, the dot that says the file is unsaved coming before it, so taking the
 * last one is taking the close chip.
 */
const closeTabs = async (ids) => {
  if (ids.size === 0) return;
  for (let round = 0; round < 12; round += 1) {
    const left = await evaluate(`(() => {
      ${PRESS}
      const ids = ${JSON.stringify([...ids])};
      let closed = 0;
      for (const tab of document.querySelectorAll("[data-tab-id]")) {
        if (!ids.includes(tab.getAttribute("data-tab-id"))) continue;
        const chip = [...tab.querySelectorAll("[aria-label]")].pop();
        if (!chip) continue;
        press(chip);
        closed += 1;
      }
      return closed;
    })()`);
    if (left === 0) return;
    // A close the app wants to ask about is confirmed by the last button of the dialog it puts up.
    await evaluate(`(() => {
      ${PRESS}
      const dialog = document.querySelector("[role=alertdialog]");
      if (!dialog) return false;
      const buttons = [...dialog.querySelectorAll("button")];
      const confirm = buttons[buttons.length - 1];
      if (!confirm) return false;
      press(confirm);
      return true;
    })()`);
    await sleep(400);
  }
};

/**
 * Make a tab the one on screen.
 *
 * The status bar follows the tab that is current: with a document on screen it names that document's
 * folder, and the terminal that has just been opened is only asked about once it is the current tab.
 *
 * A tab chip is a Radix trigger and switches on `mousedown` - a `pointerdown` is not the same event
 * to React, and a bare `click` alone does not switch it either.
 */
const activateTab = async (id) => {
  const switched = await evaluate(`(() => {
    const tab = [...document.querySelectorAll("[data-tab-id]")].find(
      (el) => el.getAttribute("data-tab-id") === ${JSON.stringify(id)},
    );
    if (!tab) return false;
    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    tab.click();
    return true;
  })()`);
  if (!switched) fail(`the tab that was just opened (${id}) is not in the strip`);
  await sleep(600);
};

/** The status bar's path, as the attributes the trail carries. */
const readTrail = () =>
  evaluate(`(() => {
    const segments = [...document.querySelectorAll("[data-breadcrumb-segment]")].map((node) => ({
      label: (node.innerText || "").trim(),
      path: node.getAttribute("data-breadcrumb-segment"),
    }));
    const current = document.querySelector("[data-breadcrumb-current]");
    return {
      segments,
      current: current ? (current.innerText || "").replace(/\\u200b/g, "").trim() : null,
      currentPath: current?.getAttribute("data-breadcrumb-current") ?? null,
      carets: [...document.querySelectorAll("[data-breadcrumb-sibling]")].map((node) =>
        node.getAttribute("data-breadcrumb-sibling"),
      ),
    };
  })()`);

/** The open menu's items, with the one a radio item says is chosen. */
const readMenu = () =>
  evaluate(`(() => {
    const menu = document.querySelector('[role="menu"]');
    if (!menu) return null;
    return {
      labels: [...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].map((node) =>
        (node.innerText || "").replace(/\\u200b/g, "").trim(),
      ),
      checked: [...menu.querySelectorAll('[role="menuitemradio"][data-state="checked"]')].map((node) =>
        (node.innerText || "").replace(/\\u200b/g, "").trim(),
      ),
    };
  })()`);

/** Click a menu item by the first line of its text (an item may carry its shortcut below it). */
const clickMenuItem = async (label) => {
  const clicked = await evaluate(`(() => {
    ${PRESS}
    const menu = document.querySelector('[role="menu"]');
    const items = [...(menu?.querySelectorAll('[role="menuitem"], [role="menuitemradio"]') ?? [])];
    const item = items.find(
      (node) => (node.innerText || "").trim().split("\\n")[0].trim() === ${JSON.stringify(label)},
    );
    if (!item) return false;
    press(item);
    return true;
  })()`);
  if (!clicked) fail(`the menu has no item reading ${label}`);
  await sleep(400);
};

/**
 * The session ids the host holds, as the app's own diagnostics report them.
 *
 * No dev hook is needed for this: `pty_diagnostics` is a product command, and a session opened by the
 * window itself (through Ctrl+T) is one the page has a receiver for.
 */
const ptySessionIds = async () =>
  new Set(
    await evaluate(
      `window.__TAURI_INTERNALS__.invoke("pty_diagnostics").then((d) => d.sessions.map((s) => s.id))`,
    ),
  );

/**
 * Write to the shell of a session the app opened: raw bytes with the id in a header, exactly the way a
 * pane writes to its own pty. The answer is the error, when there is one, so a refusal is reported
 * rather than thrown from inside an expression.
 */
const writeToPty = (id, text) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke("pty_write", new TextEncoder().encode(${JSON.stringify(text)}), { headers: { "x-pty-id": String(${id}) } }).then(() => true).catch((e) => String(e))`,
  );

/** Whether the trail's current folder is this one. */
const crumbIs = (expected) =>
  `document.querySelector("[data-breadcrumb-current]")?.getAttribute("data-breadcrumb-current") === ${JSON.stringify(expected)}`;

/** Press a trigger the way a pointer does.
 *
 * Radix opens a menu on `pointerdown`, and a plain `click` never opens it.
 */
const press = async (expression) => {
  const pressed = await evaluate(`(() => {
    const node = ${expression};
    if (!node) return false;
    for (const type of ["pointerdown", "pointerup", "click"]) {
      node.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true }));
    }
    return true;
  })()`);
  if (!pressed) fail(`nothing to press: ${expression}`);
};

/** Escape a menu without choosing anything. */
const closeMenu = async () => {
  await evaluate(
    `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
  );
  await sleep(250);
};

let terminal = null;
/** The tabs this run opened, which are the only ones it closes again. */
let opened = new Set();
const cleanup = () => {
  rmSync(ROOT, { recursive: true, force: true });
};
process.on("exit", cleanup);

try {
  report.fixture = asPosix(ROOT);
  // The same folder, spelled the way the shell spells it: Git-Bash's `/tmp` is the user's temp
  // directory, which is where the fixture was made.
  const msys = `/tmp/${basename(ROOT)}/inside`;
  report.msys = msys;

  // ---- What the app answers about that spelling, before any UI is looked at ----
  const translated = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("translate_path", { path: ${JSON.stringify(msys)}, shell: null })`,
  );
  report.translated = translated;
  if (!translated || asPosix(String(translated)) !== asPosix(INSIDE)) {
    fail(`the shell's spelling ${msys} translated to ${JSON.stringify(translated)}, not ${asPosix(INSIDE)}`);
  }
  // And why it matters: the spelling the shell reports is one a listing cannot open at all.
  const rawListing = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("list_subdirs", { path: ${JSON.stringify(msys)}, showHidden: true, workspace: null }).then(() => "ok").catch((e) => String(e))`,
  );
  report.rawListing = rawListing;
  if (rawListing === "ok") {
    fail(`the raw spelling ${msys} listed a directory, so nothing here shows what the translation is for`);
  }

  // ---- A terminal of the product's own, so the session it opens has a receiver on the page ----
  const before = await tabIds();
  const sessionsBefore = await ptySessionIds();
  // The window's own shortcut, which is the path the user takes. The window has to be in front for
  // its key routing to hear the chord at all.
  await send("Page.bringToFront");
  await sleep(500);
  for (const type of ["rawKeyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type,
      modifiers: 2,
      key: "t",
      code: "KeyT",
      windowsVirtualKeyCode: 84,
      nativeVirtualKeyCode: 84,
    });
  }
  report.openedBy = "Ctrl+T";
  // What opened it: the tab that was not there before this run - and the session with it.
  for (let attempt = 0; attempt < 30 && opened.size === 0; attempt += 1) {
    opened = new Set([...(await tabIds())].filter((id) => !before.has(id)));
    if (opened.size === 0) await sleep(250);
  }
  if (opened.size === 0) fail("the new-tab menu opened no tab");
  // The terminal has to be the tab on screen: the status bar names the current document's folder
  // when a document is what is on screen, and this probe is about a shell's own path.
  for (const id of opened) await activateTab(id);
  for (let attempt = 0; attempt < 40 && !terminal; attempt += 1) {
    terminal = [...(await ptySessionIds())].find((id) => !sessionsBefore.has(id)) ?? null;
    if (!terminal) await sleep(250);
  }
  report.terminal = terminal;
  if (!terminal) fail("the tab opened no session, so nothing can be typed into it");

  // The shell has to be reading before anything is written at it, and a shell that has not drawn its
  // prompt yet is one whose keystrokes go nowhere: hence the retry.
  await sleep(2500);
  let arrived = false;
  const attempts = [];
  for (let attempt = 0; attempt < 4 && !arrived; attempt += 1) {
    attempts.push(await writeToPty(terminal, `cd "${msys}"\r`));
    arrived = await waitFor(crumbIs(asPosix(INSIDE)), 8000);
  }
  report.writes = attempts;
  report.trail = await readTrail();
  if (!arrived) {
    fail(
      `the shell was moved to ${msys} and the trail never showed ${asPosix(INSIDE)}: ${JSON.stringify(report.trail)}`,
    );
  }
  if (report.trail.current !== "inside") {
    fail(
      `the trail's current folder is ${JSON.stringify(report.trail.current)}, not the one the shell moved to`,
    );
  }

  // ---- The folder you are in lists the folders beside it, under its own children ----
  await press(`document.querySelector("[data-breadcrumb-current]")`);
  if (!(await waitFor(`!!document.querySelector('[role="menu"]')`, 8000))) {
    fail("the folder's menu did not open");
  }
  // Two listings are asked for and both arrive asynchronously: the folder's own children from the
  // folder itself, and the ones beside it from the folder above. The menu is read once both are in.
  if (!(await waitFor(`/sibling-a/.test(document.querySelector("[role='menu']")?.innerText ?? "")`, 10000))) {
    report.currentMenu = await readMenu();
    fail(`the folder's menu never listed the folders beside it: ${JSON.stringify(report.currentMenu)}`);
  }
  const inside = await readMenu();
  report.currentMenu = inside;
  if (!inside) fail("the folder's menu did not open");
  for (const name of ["deeper", "sibling-a", "sibling-b"]) {
    if (!inside.labels.includes(name)) {
      fail(`${name} is not in the folder's menu: ${JSON.stringify(inside.labels)}`);
    }
  }
  if (inside.checked.length !== 1 || inside.checked[0] !== "inside") {
    fail(`the folder's own name is not the one marked as being here: ${JSON.stringify(inside.checked)}`);
  }

  // ---- Choosing one beside it moves there ----
  await clickMenuItem("sibling-a");
  const moved = await waitFor(
    `document.querySelector("[data-breadcrumb-current]")?.getAttribute("data-breadcrumb-current") === ${JSON.stringify(asPosix(BESIDE))}`,
    20000,
  );
  report.afterMove = await readTrail();
  if (!moved) {
    fail(`choosing sibling-a did not move the shell there: ${JSON.stringify(report.afterMove)}`);
  }

  // ---- A segment's own caret lists the folders beside that segment ----
  const leading = report.afterMove.segments[0];
  const caret = report.afterMove.carets.find((path) => path === leading?.path);
  report.leading = leading;
  if (!caret) {
    fail(`the first segment (${JSON.stringify(leading)}) has no caret beside it`);
  }
  await press(
    `[...document.querySelectorAll("[data-breadcrumb-sibling]")].find((el) => el.getAttribute("data-breadcrumb-sibling") === ${JSON.stringify(caret)})`,
  );
  if (!(await waitFor(`!!document.querySelector('[role="menu"]')`, 8000))) {
    fail("the segment's caret did not open a menu");
  }
  const beside = await readMenu();
  report.segmentMenu = beside;
  // What the app itself says is in the folder above: the menu has to be that list, and it has to mark
  // the folder the segment names as the one that is here.
  const parent = asPosix(dirname(caret));
  const real = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("list_subdirs", { path: ${JSON.stringify(parent)}, showHidden: true, workspace: null })`,
  );
  report.parent = parent;
  report.parentFolders = real?.length ?? -1;
  if (!beside) fail("the segment's menu did not open");
  if (beside.labels.length === 0) fail(`the menu beside ${parent} lists nothing`);
  const unknown = beside.labels.filter((label) => !real.includes(label));
  if (unknown.length > 0) {
    fail(`the menu beside ${parent} lists folders that are not there: ${JSON.stringify(unknown)}`);
  }
  if (beside.checked.length !== 1 || beside.checked[0] !== basename(caret)) {
    fail(
      `the segment whose folders these are is not the one marked: ${JSON.stringify(beside.checked)} vs ${basename(caret)}`,
    );
  }
  await closeMenu();

  report.ok = true;
  console.log(
    "PASS: 底部路径能切换同级文件夹——当前文件夹的菜单同时列出子目录与同级（当前项打勾），点同级即 cd 过去；每一段的分隔箭头列出该段父目录的子文件夹（与 list_subdirs 一致）并标出当前所在。",
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    `FAIL: ${error instanceof ProbeFailure ? error.message : String(error?.message ?? error)}`,
  );
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  try {
    if (terminal) {
      await evaluate(
        `window.__TAURI_INTERNALS__.invoke("pty_close", { id: ${JSON.stringify(terminal)} })`,
      );
      await sleep(400);
    }
    await closeTabs(opened);
  } catch {
    // The window may already be gone; the fixture is removed either way.
  }
  cleanup();
  // The fixture goes, and the socket with it: an open debugger socket keeps node alive past the
  // result, which reads as a probe that hung.
  socket.close();
}
