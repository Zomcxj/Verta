// A run's detail panel: whether it is bounded by the window, whether its log scrolls inside it, and
// whether it can be closed from where it ends up.
//
// The complaint was that a run's log stood in the window as a two-thousand-line column that could
// not be reached. Nothing here is readable from the source: the panel's height comes from a shared
// dialog style topped up to fit its content, and whether the log scrolls depends on which ancestor
// owns the overflow. So this reads both boxes off the rendered panel.
//
// Usage:
//   node scripts/dev/probes/run-detail-height.mjs --match=http://tauri.localhost/
//   node scripts/dev/probes/run-detail-height.mjs --match=http://tauri.localhost/ --close
//
// It measures a run detail that is already open: open one first (a repository's runs list, then a
// run's own detail button). `--close` presses the panel's close button afterwards and reads whether
// the panel is gone, which is the half a screenshot cannot answer.
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const match = arg("match") ?? "http://tauri.localhost/";
const close = process.argv.includes("--close");

const target = (await (await fetch("http://127.0.0.1:9222/json")).json()).find(
  (t) => t.type === "page" && t.url === match,
);
if (!target) {
  console.error(`没找到 ${match} 这个窗口`);
  process.exit(1);
}
const socket = new WebSocket(target.webSocketDebuggerUrl);
let id = 1;
const pending = new Map();
await new Promise((r) => socket.addEventListener("open", () => r()));
socket.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  pending.get(m.id)?.(m);
  pending.delete(m.id);
});
const send = (method, params) =>
  new Promise((res, rej) => {
    const i = id++;
    pending.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    socket.send(JSON.stringify({ id: i, method, params }));
  });
const evalIn = async (body) => {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => {\n${body}\n})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const reading = await evalIn(`
  const panel = document.querySelector("[data-slot=dialog-content]");
  if (!panel) return { open: false };
  const p = panel.getBoundingClientRect();
  // The log body is the scroll container: monospaced, with an overflow it actually uses.
  const log = [...panel.querySelectorAll("div")].find((el) => {
    const s = getComputedStyle(el);
    return /mono/.test(el.className) && /auto|scroll/.test(s.overflowY);
  });
  const l = log?.getBoundingClientRect();
  const closeButton = panel.querySelector("[data-slot=dialog-close]");
  const c = closeButton?.getBoundingClientRect();
  return {
    open: true,
    viewport: [innerWidth, innerHeight],
    panel: { width: Math.round(p.width), height: Math.round(p.height), top: Math.round(p.top), bottom: Math.round(p.bottom) },
    log: log
      ? {
          width: Math.round(l.width),
          height: Math.round(l.height),
          scrollHeight: log.scrollHeight,
          scrolls: log.scrollHeight > log.clientHeight + 1,
          lines: log.children.length
        }
      : null,
    closeAt: c ? [Math.round(c.left + c.width / 2), Math.round(c.top + c.height / 2)] : null
  };
`);

if (!reading.open) {
  console.error("没有打开的运行详情面板：先打开某次运行的「详情」，再跑这个探针。");
  process.exit(2);
}

console.log(
  `窗口 ${reading.viewport[0]}x${reading.viewport[1]}；面板 ${reading.panel.width}x${reading.panel.height}，` +
    `上 ${reading.panel.top} 下 ${reading.panel.bottom}`,
);
console.log(
  reading.log
    ? `日志框 ${reading.log.width}x${reading.log.height}，内容高 ${reading.log.scrollHeight}，${reading.log.lines} 行，` +
        `${reading.log.scrolls ? "在面板里滚" : "没有滚动"}`
    : "没有找到日志框",
);

const failures = [];
if (reading.panel.bottom > reading.viewport[1] || reading.panel.top < 0) {
  failures.push(
    `面板出了窗口（上 ${reading.panel.top}，下 ${reading.panel.bottom}，视口高 ${reading.viewport[1]}）`,
  );
}
if (reading.panel.height > reading.viewport[1]) {
  failures.push(`面板比窗口还高（${reading.panel.height} > ${reading.viewport[1]}）`);
}
if (reading.log === null) {
  failures.push("没找到日志框，这一轮什么都没量到");
} else if (!reading.log.scrolls) {
  failures.push(`日志没有在面板里滚动（内容 ${reading.log.scrollHeight} 高，框 ${reading.log.height} 高）`);
}

if (close) {
  if (!reading.closeAt) {
    failures.push("面板上没有关闭按钮");
  } else {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x: reading.closeAt[0],
        y: reading.closeAt[1],
        button: "left",
        clickCount: 1,
      });
    }
    await sleep(1200);
    const left = await evalIn(`return document.querySelectorAll("[data-slot=dialog-content]").length;`);
    console.log(`\n按下关闭后：面板还剩 ${left} 个`);
    if (left !== 0) failures.push("按下面板自己的关闭按钮没能把它关掉");
  }
}

if (failures.length === 0) {
  console.log(
    `\n通过：面板被窗口夹住，日志在面板里滚${close ? "，关闭按钮关得掉" : ""}。`,
  );
  process.exit(0);
}
console.log("\n不通过：");
for (const line of failures) console.log(`  - ${line}`);
process.exit(1);
