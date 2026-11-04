// When a drop lands on a name the folder already holds, is the user asked - and does the answer hold?
//
// The report: "拖入有同名的只警告 没有覆盖或者跳过选项". `copy-drop-conflict.mjs` checks what the three
// commands do; this checks the part between them - that the drop path asks, that the question names
// what it is about, and that the answer produces what it promises on disk.
//
// The drop itself is a native one, so it cannot be made from here: what this does is deliver the
// same event the webview receives from the OS (`tauri://drag-drop` on the webview target, same
// payload shape) at a point inside the explorer. Everything after that - resolving the folder,
// looking for clashes, asking, copying - is the app's own code, unwatched and unmodified.
//
// One drop per run, on purpose. Opening a tab makes the explorer follow it, and under a WSL
// workspace that folder is rewritten from a Windows spelling to a WSL one a few seconds later, so a
// drop sent after that points at a folder the distro does not have. Measured: a first drop in the
// window worked and a second one, three seconds later, was delivered but did nothing.
//
// The fixture is a folder of its own with one file its destination already holds, and the tab it
// opens is closed again. Nothing of the user's is copied, replaced or moved.
//
// Usage:
//   node scripts/dev/probes/explorer-drop-conflict-dialog.mjs                 # answers "skip"
//   node scripts/dev/probes/explorer-drop-conflict-dialog.mjs --choice=replace
//   node scripts/dev/probes/explorer-drop-conflict-dialog.mjs --conflicts=2   # two names at once
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const choice =
  process.argv.find((a) => a.startsWith("--choice="))?.slice(9) ?? "skip";
if (choice !== "skip" && choice !== "replace") {
  console.error(`--choice must be skip or replace, not ${choice}`);
  process.exit(2);
}
// How many names the destination already holds. Two is the case the wording changes for.
const conflicts =
  Number(process.argv.find((a) => a.startsWith("--conflicts="))?.slice(12) ?? "1") || 1;

const root = mkdtempSync(join(tmpdir(), "verta-probe-dialog-")).replace(/\\/g, "/");
const ws = `${root}/workspace`;
const from = `${root}/from`;
mkdirSync(ws, { recursive: true });
mkdirSync(from, { recursive: true });
writeFileSync(join(ws, "a.txt"), "old A");
writeFileSync(join(from, "a.txt"), "new A");
writeFileSync(join(from, "b.txt"), "new B");
const alsoClash = conflicts > 1 ? ["c.txt"] : [];
for (const name of alsoClash) {
  writeFileSync(join(ws, name), "old C");
  writeFileSync(join(from, name), "new C");
}
const read = (name) => {
  try {
    return readFileSync(join(ws, name), "utf8");
  } catch {
    return null;
  }
};

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) {
  console.error("dev 起来了？没找到主窗口的 page 目标。");
  process.exit(1);
}
const socket = new WebSocket(page.webSocketDebuggerUrl);
let seq = 1;
const pending = new Map();
await new Promise((r) => socket.addEventListener("open", () => r()));
socket.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  const q = pending.get(m.id);
  if (q) {
    pending.delete(m.id);
    q(m);
  }
});
const send = (method, params) =>
  new Promise((res) => {
    const i = seq++;
    pending.set(i, res);
    socket.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(ex.exception?.description ?? ex.text);
  return r.result?.result?.value;
};

// The tab that was on screen, put back at the end.
const wasActive = await ev(`(() => {
  const tab = document.querySelector("[role=tab][data-tab-id][data-tab-active]");
  return tab ? (tab.textContent || "").trim() : null;
})()`);

// A tab at the fixture: the explorer follows the tab on screen, which is how the drop gets a folder
// that is this probe's own rather than one of the user's.
const opened = JSON.parse(
  await ev(`JSON.stringify(window.__vertaNewAgentTab(${JSON.stringify(ws)}, "drop-probe", "claude"))`),
);
const { tabId } = opened;
console.log(`tab at the fixture opened (tab ${tabId})`);

// The tab this probe opened goes away again, and the tab that was on screen comes back. Defined
// here so a run that bails out early still leaves the app as it found it.
const closeProbeTab = () =>
  ev(`(async () => {
    const press = (node) => {
      const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
      node.dispatchEvent(new PointerEvent("pointerdown", opts));
      node.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
      node.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
    };
    const tab = document.querySelector('[role=tab][data-tab-id="${tabId}"]');
    const close = tab?.querySelector("[data-no-drag][role=button]");
    if (close) press(close);
    await new Promise((r) => setTimeout(r, 900));
    const guard = document.querySelector("[role=alertdialog]");
    if (guard) {
      const buttons = [...guard.querySelectorAll("button")];
      const confirm = buttons[buttons.length - 1];
      if (confirm) press(confirm);
      await new Promise((r) => setTimeout(r, 900));
    }
    const back = ${JSON.stringify(wasActive)} === null ? null
      : [...document.querySelectorAll("[role=tab][data-tab-id]")].find(
          (n) => (n.textContent || "").trim() === ${JSON.stringify(wasActive)});
    if (back) press(back);
    return JSON.stringify({
      closed: close !== null,
      guard: guard !== null,
      restored: back !== null,
      strip: [...document.querySelectorAll("[role=tab][data-tab-id]")]
        .map((n) => (n.textContent || "").trim()),
    });
  })()`);

const bail = async (why) => {
  console.error(why);
  console.log(`cleanup: ${await closeProbeTab()}`);
  socket.close();
  process.exit(1);
};

// The explorer has to be the view on screen, or there is no drop zone to land in.
const shown = await ev(`(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  await invoke("workspace_authorize", { path: ${JSON.stringify(root)}, workspace: { kind: "local" } });
  const press = (node) => {
    const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
    node.dispatchEvent(new PointerEvent("pointerdown", opts));
    node.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
    node.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
  };
  for (let i = 0; i < 24; i++) {
    if (document.querySelector("[data-explorer-drop]")) return "visible";
    const view = [...document.querySelectorAll("button")]
      .find((b) => /^(文件|Files)$/.test((b.textContent || "").trim()));
    if (view) press(view);
    else {
      const toggle = [...document.querySelectorAll("button")]
        .find((b) => /显示\\/隐藏侧栏|Toggle sidebar/i.test(b.title || ""));
      if (toggle) press(toggle);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return "no drop zone";
})()`);
console.log(`explorer: ${shown}`);

// The tree has to be showing the fixture before a drop can mean anything: `explorerRoot` follows the
// tab on screen, and until it has caught up a drop is either ignored or lands in the folder the
// previous tab was looking at.
let rooted = null;
for (let i = 0; i < 40; i++) {
  const rows = JSON.parse(
    await ev(`JSON.stringify([...document.querySelectorAll("[data-fs-path]")]
      .map((el) => el.getAttribute("data-fs-path")))`),
  );
  if (rows.includes(`${ws}/a.txt`)) {
    rooted = rows;
    break;
  }
  await sleep(150);
}
if (!rooted) await bail("explorer 没有指向夹具，无法投递。");
console.log(`rows: ${JSON.stringify(rooted)}`);

// A point inside the list, below the last row: the folder itself as a destination.
const spot = JSON.parse(
  await ev(`(() => {
    const zone = document.querySelector("[data-explorer-drop]");
    if (!zone) return JSON.stringify(null);
    const r = zone.getBoundingClientRect();
    const rows = [...zone.querySelectorAll("[data-fs-path]")]
      .map((el) => el.getBoundingClientRect().bottom);
    const y = Math.max(r.top + 8, Math.min(r.bottom - 8, (rows.at(-1) ?? r.top) + 30));
    return JSON.stringify({ x: r.left + r.width / 2, y });
  })()`),
);
if (!spot) await bail("explorer 里没有 drop zone，无法投递。");

// What the drop point is over - the app resolves the destination from exactly this.
const overPoint = JSON.parse(
  await ev(`(() => {
    const el = document.elementFromPoint(${spot.x}, ${spot.y});
    return JSON.stringify({
      at: el ? el.tagName : null,
      zone: Boolean(el?.closest?.("[data-explorer-drop]")),
    });
  })()`),
);
console.log(`drop point: (${Math.round(spot.x)}, ${Math.round(spot.y)}) over ${JSON.stringify(overPoint)}`);
if (!overPoint.zone) await bail("投放点不在文件列表里（可能有对话框挡着），无法投递。");

const sources = [`${from}/a.txt`, ...alsoClash.map((n) => `${from}/${n}`), `${from}/b.txt`];
await ev(`(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const label = window.__TAURI_INTERNALS__.metadata.currentWebview.label;
  const target = { kind: "Webview", label };
  const position = { x: ${spot.x}, y: ${spot.y} };
  await invoke("plugin:event|emit_to", {
    target, event: "tauri://drag-enter", payload: { paths: ${JSON.stringify(sources)}, position },
  });
  await invoke("plugin:event|emit_to", {
    target, event: "tauri://drag-over", payload: { position },
  });
  await invoke("plugin:event|emit_to", {
    target, event: "tauri://drag-drop", payload: { paths: ${JSON.stringify(sources)}, position },
  });
  return "delivered";
})()`);

const readDialog = () =>
  ev(`(() => {
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]');
    if (!dialog) return JSON.stringify(null);
    return JSON.stringify({
      text: dialog.innerText.replace(/\\s+/g, " ").trim(),
      buttons: [...dialog.querySelectorAll("button")].map((b) => b.innerText.trim()),
      inputs: dialog.querySelectorAll("input, textarea").length,
    });
  })()`).then((raw) => JSON.parse(raw));

let asked = null;
for (let i = 0; i < 40; i++) {
  await sleep(150);
  asked = await readDialog();
  if (asked) break;
}
if (!asked) await bail("没有弹窗：投放没有走到问的那一步。");
console.log(`\nquestion: ${JSON.stringify(asked)}`);
const namesOk = asked.text.includes("a.txt") && alsoClash.every((n) => asked.text.includes(n));

const clicked = await ev(`(() => {
  const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]');
  const button = [...dialog.querySelectorAll("button")]
    .find((b) => new RegExp(${JSON.stringify(choice === "skip" ? "跳过|Skip" : "覆盖|Replace")}, "i").test(b.innerText));
  if (!button) return "no such button";
  button.click();
  return "clicked";
})()`);
await sleep(2500);
const after = {
  a: read("a.txt"),
  b: read("b.txt"),
  also: Object.fromEntries(alsoClash.map((n) => [n, read(n)])),
  dialog: await readDialog(),
};
console.log(`clicked ${clicked}; after: ${JSON.stringify({ a: after.a, b: after.b, also: after.also, dialog: after.dialog })}`);

const expectedA = choice === "skip" ? "old A" : "new A";
const expectedC = choice === "skip" ? "old C" : "new C";
const answerOk =
  after.a === expectedA &&
  after.b === "new B" &&
  after.dialog === null &&
  alsoClash.every((n) => read(n) === expectedC);

console.log(`\ncleanup: ${await closeProbeTab()}`);
const pass = namesOk && answerOk && asked.inputs === 0;
console.log(
  pass
    ? `\nPASS: the drop asked, named the clashing file, and "${choice}" did what it said on disk.`
    : `\nFAIL: namesOk=${namesOk} answerOk=${answerOk} inputs=${asked.inputs}`,
);

socket.close();
// The shell this probe opened may still hold the folder for a moment after its tab closes.
for (let i = 0; i < 10; i++) {
  try {
    rmSync(root, { recursive: true, force: true });
    break;
  } catch {
    await sleep(300);
  }
}
process.exit(pass ? 0 : 1);
