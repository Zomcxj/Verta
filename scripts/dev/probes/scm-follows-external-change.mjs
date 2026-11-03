// Does the source control panel notice a change it did not make?
//
// Reported as "刚才右侧工作区提交后要刷新才知道全部提交了 没实时更新". The panel refreshed on a context
// change, on window focus, and after its own buttons - and on nothing else, so anything done outside
// it, a commit or an `rm` typed in a terminal, left the file list as it was until the user asked
// again.
//
// Two things have to be true, and they are measured separately:
//  1. a commit makes the watcher speak at all - `commit-fires-watch-event.mjs`;
//  2. the panel answers such an event with its own read - this one.
//
// This one asks the question the user asks: with the panel on screen, change the working copy from
// outside the app and see whether the rows move on their own. A file of this probe's own is created
// and then removed; both are changes git reports, and the panel has to show them without a click.
// Nothing of the user's is touched, and the file is deleted before the run ends.
//
// Usage: node scripts/dev/probes/scm-follows-external-change.mjs
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = "D:/VsPro/Verta";
// At the repository root: the watcher reports one directory deep, so a file two levels down is a
// change no watch of the root can see - measured, it produced no event at all.
const SCRATCH = join(REPO, "scm-event-probe.txt");

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
const readRows = async () =>
  JSON.parse(
    await ev(`JSON.stringify([...document.querySelectorAll("[data-scm-path]")]
      .map((el) => el.getAttribute("data-scm-path")))`),
  );

// The panel follows the tab on screen, so the repository has to be what that tab is looking at.
const opened = await ev(
  `JSON.stringify(window.__vertaNewAgentTab(${JSON.stringify(REPO)}, "scm-probe", "claude"))`,
);
const { leafId } = JSON.parse(opened);
await sleep(2500);
console.log(`terminal at the repository opened (leaf ${leafId})`);

const toggled = await ev(`(() => {
  if (document.querySelectorAll("[data-scm-row]").length > 0) return "already open";
  const toggle = [...document.querySelectorAll("button")].find((b) =>
    /显示\\/隐藏 Git 面板|Toggle git panel/i.test(b.title || b.getAttribute("aria-label") || ""));
  if (!toggle) return "no git panel toggle";
  toggle.click();
  return "toggled";
})()`);
console.log(`git panel: ${toggled}`);

let before = [];
for (let i = 0; i < 40; i++) {
  before = await readRows();
  if (before.length > 0) break;
  await sleep(250);
}
console.log(`rows before the change: ${before.length}`);

// The change the panel did not make.
const started = Date.now();
writeFileSync(SCRATCH, "written by the probe\n");
let added = null;
for (let i = 0; i < 40; i++) {
  await sleep(150);
  const now = await readRows();
  if (now.length > before.length) {
    added = Date.now() - started;
    console.log(`rows after the file appeared: ${now.length}`);
    console.log(`  new row: ${JSON.stringify(now.filter((p) => !before.includes(p)))}`);
    break;
  }
}

// And back out again, which is the same claim in the other direction.
let removed = null;
if (added !== null) {
  const gone = Date.now();
  rmSync(SCRATCH, { force: true });
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    const now = await readRows();
    if (now.length === before.length) {
      removed = Date.now() - gone;
      break;
    }
  }
}

const pass = added !== null && removed !== null;
console.log(
  pass
    ? `\nPASS: the list followed a change made outside the app - new row in ${added} ms, gone in ${removed} ms, nothing clicked.`
    : `\nFAIL: added=${added ?? "never"}, removed=${removed ?? "never"} (rows started at ${before.length}).`,
);

rmSync(SCRATCH, { force: true });
// Leave the window the way it was found.
await ev(`(() => {
  const tab = [...document.querySelectorAll("[data-tab-id]")]
    .find((el) => /scm-probe/.test(el.innerText || ""));
  if (!tab) return "no tab";
  const closer = tab.querySelector('[aria-label*="关闭"], [aria-label*="Close"]');
  if (closer) { closer.click(); return "closed"; }
  return "no close button";
})()`);
await sleep(1200);
socket.close();
process.exit(pass ? 0 : 1);
