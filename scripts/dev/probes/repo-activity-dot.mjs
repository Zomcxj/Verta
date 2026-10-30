// The dot beside a repository name: is it there, where is it, and does reading clear it.
//
// The rule behind the dot is covered by unit tests; what only a real window can answer is whether
// the dot is drawn next to the name, whether it survives a long name without being squeezed, and
// whether it goes away once an entry has been opened. All of that is read out of the live page,
// not inferred from the source.
//
// What is measured, per repository row: the name, whether a `[data-repo-activity="new"]` dot
// exists, its box, its colour converted to sRGB (Tailwind ships oklch, so the computed value is
// not a plain rgb string), and its position relative to the right edge of the name it belongs to.
// The attribute is written only when the dot is drawn, so a row without it has no dot.
//
// Usage (a window started with --remote-debugging-port=9222, remote repositories showing):
//   node scripts/dev/probes/repo-activity-dot.mjs --match=http://tauri.localhost/
//   node scripts/dev/probes/repo-activity-dot.mjs --hover=Zomcxj/Verta --expect=new
//   node scripts/dev/probes/repo-activity-dot.mjs --hover=Zomcxj/MemoPaw --expect=none
//
// `--hover` moves the real pointer onto that row (the event the app listens for) and waits 2.5s
// for the answer before reading, because the question is only asked when a row is touched.
// `--expect` fails the run when the dot is not what was expected. Exits 2 when the layer or the
// row is not there at all: nothing measured is not a pass.
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const match = arg("match") ?? "http://tauri.localhost/";
const hover = arg("hover");
const expect = arg("expect");

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

/**
 * Rows of the remote layer as an expression.
 *
 * Found through the repository filter box rather than through a column heading, so the probe works
 * in either interface language; and only while that layer is the one on screen, because the local
 * projects list is its own table in the same document.
 */
const ROWS = `(() => {
  const filter = [...document.querySelectorAll("input[placeholder]")].find((i) =>
    /筛选仓库|Filter repositories/.test(i.getAttribute("placeholder") || ""));
  if (!filter) return null;
  const layer = filter.closest("[aria-hidden]");
  if (layer && layer.getAttribute("aria-hidden") !== "false") return null;
  const table = (layer ?? document).querySelector("table");
  if (!table) return null;
  return [...table.querySelectorAll("tbody tr")];
})()`;

/** One reading of every row, inside the page. */
const READ = `
  const list = ${ROWS};
  if (!list) return null;
  return list.map((tr) => {
    const nameEl = tr.querySelector("td span span");
    const dot = tr.querySelector('[data-repo-activity="new"]');
    if (!dot) return { name: (nameEl?.textContent || "").trim(), dot: null };
    const r = dot.getBoundingClientRect();
    // Paint the computed colour onto a canvas so oklch becomes the sRGB triple a person can judge.
    const c = document.createElement("canvas");
    c.width = 1; c.height = 1;
    const ctx = c.getContext("2d");
    ctx.fillStyle = getComputedStyle(dot).backgroundColor;
    ctx.fillRect(0, 0, 1, 1);
    const p = ctx.getImageData(0, 0, 1, 1).data;
    return {
      name: (nameEl?.textContent || "").trim(),
      dot: {
        left: Math.round(r.left), top: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
        rgb: [p[0], p[1], p[2]],
        nameRight: nameEl ? Math.round(nameEl.getBoundingClientRect().right) : null,
      },
    };
  });
`;

const first = await evalIn(READ);
if (!first) {
  console.error("远程仓库层不是当前层（或没有这张表）：先把「本地项目与远程仓库 / Local and remote repositories」面板开到远程仓库，再跑这个探针。");
  process.exit(2);
}

if (hover) {
  const at = await evalIn(`
    const list = ${ROWS};
    if (!list) return null;
    const tr = list.find((tr) => (tr.textContent || "").includes(${JSON.stringify(hover)}));
    if (!tr) return null;
    const r = tr.getBoundingClientRect();
    return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
  `);
  if (!at) {
    console.error(`列表里没有含「${hover}」的行`);
    process.exit(2);
  }
  // Away first, then onto it: a webview that has not seen the pointer yet does not produce an
  // enter event for a move that lands on the element it is already considered inside.
  for (const [x, y] of [[at[0], at[1] - 40], at]) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await sleep(120);
  }
  await sleep(2500);
}

const shown = (await evalIn(READ)) ?? first;
for (const row of shown) {
  const dot = row.dot
    ? `点 ${row.dot.w}x${row.dot.h} @(${row.dot.left},${row.dot.top}) rgb(${row.dot.rgb.join(", ")})` +
      ` · 名字右沿 ${row.dot.nameRight}`
    : "无点";
  console.log(`${row.name || "(无名)"}  ${dot}`);
}

const failures = [];
const judged = hover ? shown.find((r) => r.name.includes(hover)) : null;
if (hover && !judged) failures.push(`读完以后列表里找不到「${hover}」那一行`);

if (judged && expect === "new") {
  if (!judged.dot) failures.push(`${judged.name}：期望有点，实际没有`);
  else {
    const { dot } = judged;
    // On the right of the name, not over it.
    if (dot.nameRight !== null && dot.left < dot.nameRight - 1) {
      failures.push(`${judged.name}：点(${dot.left})在名字右沿(${dot.nameRight})左边，压住了名字`);
    }
    // A 6px dot that a long name squeezed would be 0 wide.
    if (dot.w < 4 || dot.h < 4) failures.push(`${judged.name}：点被挤成 ${dot.w}x${dot.h}`);
    // Amber: bright red channel, no blue to speak of.
    const [red, green, blue] = dot.rgb;
    if (!(red > 200 && green > 120 && green < 200 && blue < 80)) {
      failures.push(`${judged.name}：点的颜色是 rgb(${dot.rgb.join(", ")})，不是琥珀色`);
    }
  }
}
if (judged && expect === "none" && judged.dot) {
  failures.push(`${judged.name}：期望没有点，实际画了一个`);
}

if (failures.length === 0) {
  const wish = expect === "new" ? "，期望的那行有点" : expect === "none" ? "，期望的那行没有点" : "";
  console.log(`\n通过：量到 ${shown.length} 行${wish}。`);
  process.exit(0);
}
console.log("\n不通过：");
for (const line of failures) console.log(`  - ${line}`);
process.exit(1);