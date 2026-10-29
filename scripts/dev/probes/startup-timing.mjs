// How long the interface takes to arrive, and where the time goes.
//
// The window is created hidden and shown by the frontend a moment after React paints, so "how slow
// does it open" is answered by the page's own timing entries - not by when the process started,
// which this cannot see. What it does see, and reports:
//
//   * how long after the probe started the page target existed at all (the webview being created),
//   * how long after that the root element had anything in it (React having painted),
//   * the page's own navigation and first-paint entries, which is the honest number: the interface
//     is on screen at first contentful paint, and the window is shown 50ms after the first render.
//
// Usage:
//   node scripts/dev/probes/startup-timing.mjs --match=tauri.localhost/
//   node scripts/dev/probes/startup-timing.mjs --match=tauri.localhost/ --wait   # retry until the app is up
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const { readFileSync } = await import("node:fs");

const match = arg("match");
/**
 * The file the caller wrote the launch time into, if it recorded one.
 *
 * It cannot be passed as an argument: the probe has to be running *before* the process is started, so
 * the number does not exist yet when the probe is launched. It is read when the probe prints instead.
 */
const launchFile = arg("launch-file");
const startedAt = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const findPage = async () => {
  // The port is not open until the webview exists, so a refusal is the normal answer here rather
  // than a failure - and it is the fetch itself that has to be caught, not the parse after it.
  try {
    const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
    return targets.find((t) => {
      if (t.type !== "page") return false;
      if (match === null) return t.url.endsWith("1420/") || t.url.endsWith("tauri.localhost/");
      return match.endsWith("/") ? t.url.endsWith(match) : t.url.includes(match);
    });
  } catch {
    return undefined;
  }
};

let page = await findPage();
const wait = process.argv.includes("--wait");
if (!page && wait) {
  // Started before the app: poll for the webview to exist at all, which is the first thing that can
  // be timed from here.
  for (let i = 0; i < 1_200; i += 1) {
    await sleep(50);
    page = await findPage();
    if (page) break;
  }
}
const targetMs = page ? Date.now() - startedAt : null;
if (!page) {
  console.error("没找到主窗口的 page 目标（app 起来了吗？--match 对吗？）");
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
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
    const i = id++;
    pending.set(i, res);
    socket.send(JSON.stringify({ id: i, method, params }));
  });
const pageEval = async (body) => {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => {\n${body}\n})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description ?? "eval failed");
  }
  return r.result.result.value;
};

/** Wait until the interface is actually in the DOM, which is what the window being shown waits for. */
let paintedMs = null;
let readyState = "loading";
for (let i = 0; i < 800; i += 1) {
  const state = await pageEval(
    `return JSON.stringify({ state: document.readyState, elements: document.querySelectorAll("*").length });`,
  ).then((raw) => JSON.parse(raw));
  readyState = state.state;
  // Two conditions, because either one alone is a lie: `complete` is reached before React has
  // rendered, and the root element has a child as soon as React commits anything at all. The
  // interface being *in* the document is what both together say.
  if (state.state === "complete" && state.elements > 200) {
    paintedMs = Date.now() - startedAt;
    break;
  }
  await sleep(50);
}

const timing = JSON.parse(
  await pageEval(`
    const nav = performance.getEntriesByType("navigation")[0];
    const paints = performance.getEntriesByType("paint");
    const fcp = paints.find((p) => p.name === "first-contentful-paint");
    return JSON.stringify({
      timeOrigin: Math.round(performance.timeOrigin),
      navigation: nav ? {
        domInteractive: Math.round(nav.domInteractive),
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
        load: Math.round(nav.loadEventEnd),
        duration: Math.round(nav.duration)
      } : null,
      firstPaint: Math.round(paints.find((p) => p.name === "first-paint")?.startTime ?? -1),
      firstContentfulPaint: Math.round(fcp?.startTime ?? -1),
      now: Math.round(performance.now()),
      readyState: document.readyState,
      elements: document.querySelectorAll("*").length,
      rootChildren: document.getElementById("root")?.childElementCount ?? 0,
      tabs: document.querySelectorAll("[role=tab][data-tab-id]").length
    });
  `),
);

const row = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);
/** Read now rather than at launch: the launcher writes it while the probe is already waiting. */
let launchMs = null;
if (launchFile !== null) {
  try {
    launchMs = Number(readFileSync(launchFile, "utf8").trim());
    if (!Number.isFinite(launchMs)) launchMs = null;
  } catch {
    launchMs = null;
  }
}
console.log("启动耗时（探针侧观察，含探针自己的起跑偏移）：");
row("探针起 → 页面目标出现", targetMs === null ? "(一开始就在)" : `${targetMs}ms`);
row("→ 界面就绪（readyState=complete）", paintedMs === null ? "(一直没就绪)" : `${paintedMs}ms`);
console.log("页面自己的时间轴（相对导航开始，与探针无关）：");
row(
  "导航开始（epoch ms）",
  `${timing.timeOrigin}${launchMs === null ? "（启动脚本没记）" : `（启动记的是 ${launchMs}）`}`,
);
row("DOM content loaded", `${timing.navigation?.domContentLoaded ?? -1}ms`);
row("load", `${timing.navigation?.load ?? -1}ms`);
row("读时的 performance.now()", `${timing.now}ms`);
row("DOM 元素数 / 标签数", `${timing.elements} / ${timing.tabs}`);
if (launchMs !== null) {
  row("进程起 → 导航开始", `${timing.timeOrigin - launchMs}ms`);
  row("进程起 → DOM 就绪", `${timing.timeOrigin - launchMs + (timing.navigation?.domContentLoaded ?? 0)}ms`);
}
// Paint entries are deliberately absent and that is not a failure: the window is created hidden
// (`visible: false`) and shown by the frontend once React has rendered, and a window nobody can see
// does not paint. So first contentful paint is not available to read here at all.

const failures = [];
if (paintedMs === null) failures.push("界面一直没进 DOM（readyState 到不了 complete 或元素太少）");
if (timing.elements <= 200) failures.push(`DOM 里只有 ${timing.elements} 个元素：界面没画出来`);
socket.close();
if (failures.length === 0) process.exit(0);
console.log("不通过：");
for (const line of failures) console.log(`  - ${line}`);
process.exit(1);