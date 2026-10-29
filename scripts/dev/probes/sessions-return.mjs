// Coming back to the sessions list: what it says in the frames before the read lands.
//
// The sidebar swaps panels with a `key`, so leaving for the file tree and coming back mounts the
// sessions panel again. Before this, the list said "no sessions" for as long as the read took - the
// person who asked for the fix described it as the list being empty for a moment and then filling
// in. Whether that still happens is a fact about frames, not about code: so this samples the panel
// right after the switch, at the speed of a frame, and reports what it drew.
//
// Usage:
//   node scripts/dev/probes/sessions-return.mjs --match=http://tauri.localhost/
//   node scripts/dev/probes/sessions-return.mjs --match=http://tauri.localhost/ --rounds=3
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const match = arg("match") ?? "http://tauri.localhost/";
const rounds = Number(arg("rounds") ?? "3");

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

/** Press a rail button by its accessible name. */
const railPress = async (label) => {
  const at = await evalIn(`
    const b = [...document.querySelectorAll("button[aria-label]")].find((b) => b.getAttribute("aria-label") === ${JSON.stringify(label)});
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
  `);
  if (!at) return false;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: at[0], y: at[1], button: "left", clickCount: 1 });
  }
  return true;
};

/**
 * One reading of the panel. Sampled inside the page, once per animation frame, so a frame that
 * lasts one paint is still caught - a probe that asks from outside sees only whatever the last
 * frame settled on.
 */
const sample = (frames) =>
  evalIn(`
    const readings = [];
    for (let i = 0; i < ${frames}; i += 1) {
      await new Promise((r) => requestAnimationFrame(r));
      const empty = document.querySelector("[data-session-empty]");
      const rows = document.querySelectorAll("[data-session-id]").length;
      readings.push(
        empty ? (empty.getAttribute("data-session-empty") || "empty") + ":" + (empty.textContent || "").trim().slice(0, 12)
              : "rows:" + rows
      );
    }
    return readings;
  `);

const failures = [];
for (let round = 1; round <= rounds; round += 1) {
  if (!(await railPress("会话"))) {
    console.error("左栏没有「会话」按钮");
    process.exit(2);
  }
  await sleep(1500);
  const settled = await sample(1);
  if (!settled[0]?.startsWith("rows:")) {
    failures.push(`第 ${round} 轮：会话列表本身是空的（${settled[0]}），先让它读到东西再量`);
    break;
  }

  // Away to the file tree and straight back.
  if (!(await railPress("文件"))) {
    console.error("左栏没有「文件」按钮");
    process.exit(2);
  }
  await sleep(900);
  await railPress("会话");
  const during = await sample(90);
  const said = during.filter((r) => r.startsWith("empty") || r.startsWith("reading"));
  console.log(`第 ${round} 轮：回来后的 ${during.length} 帧 —— ${said.length === 0 ? "帧帧都有会话" : JSON.stringify([...new Set(said)])}`);
  if (said.some((r) => r.startsWith("empty"))) {
    failures.push(`第 ${round} 轮：说了「没有会话记录」（${JSON.stringify([...new Set(said)])}）`);
  }
  await sleep(1200);
}

if (failures.length === 0) {
  console.log(`\n通过：切回来 ${rounds} 轮，没有任何一帧说「没有会话记录」。`);
  process.exit(0);
}
console.log("\n不通过：");
for (const line of failures) console.log(`  - ${line}`);
process.exit(1);
