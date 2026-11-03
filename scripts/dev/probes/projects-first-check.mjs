// Whether the first check happens on its own after the project list loads.
//
// The claim under test is that `refresh()` returning early while the list is still being read
// leaves the panel with nothing until a person presses Refresh. The panel is reloaded, the projects
// tab is opened, and from then on nothing is clicked: every row goes from "no status" to a branch
// and a state by itself, or it never does.
const targets = await (await fetch("http://localhost:9222/json")).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) {
  console.error("dev 起来了？没找到主窗口的 page 目标。");
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(
      r.result.exceptionDetails.exception?.description ??
        r.result.exceptionDetails.text,
    );
  }
  return r.result?.result?.value;
};
const click = async (expr) => {
  const rect = await ev(
    `(() => { const n = ${expr}; if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; })()`,
  );
  if (!rect || rect.w === 0) return false;
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y, button: "none" });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(60);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", buttons: 0, clickCount: 1 });
  return true;
};

// A fresh window: the list has to be read, so the early return is exercised for real.
await send("Page.reload", {});
await sleep(12000);

// Ctrl+1 is the first tab; the projects panel is opened from the header, which is what a person
// does. Nothing else is clicked after this.
await click(
  `[...document.querySelectorAll("button")].find((b) => /本地项目与远程仓库/.test(b.getAttribute("title") || ""))`,
);

/** Rows that carry a branch, i.e. a status the panel actually read. */
const read = () =>
  ev(`JSON.stringify({
    total: document.querySelectorAll("table tbody tr").length,
    withBranch: [...document.querySelectorAll("table tbody tr")].filter((tr) => {
      const cells = [...tr.querySelectorAll("td")].map((td) => (td.innerText || "").trim());
      return cells[2] && cells[2].length > 0;
    }).length,
    checking: !![...document.querySelectorAll("button")].find((b) => /刷新/.test(b.innerText || "") && b.querySelector(".animate-spin")),
  })`);

const started = Date.now();
let firstFilled = null;
let last = "";
for (let i = 0; i < 90; i++) {
  const state = JSON.parse(await read());
  const line = `rows=${state.total} withBranch=${state.withBranch} checking=${state.checking}`;
  if (line !== last) {
    console.log(`  +${((Date.now() - started) / 1000).toFixed(1)}s  ${line}`);
    last = line;
  }
  if (state.total > 0 && state.withBranch > 0 && firstFilled === null) {
    firstFilled = Date.now() - started;
    if (state.withBranch >= state.total) break;
  }
  await sleep(500);
}
console.log(
  firstFilled === null
    ? "\nNO status appeared without clicking anything"
    : `\nfirst statuses appeared ${(firstFilled / 1000).toFixed(1)}s after opening the panel, with no click`,
);
socket.close();