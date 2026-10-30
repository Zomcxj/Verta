// Which session rows carry an agent dot, and in which state.
//
// Two sources can mark a row and they mean different things: a session open in a tab is described by
// its pty (blue question, orange work, green at rest), while a session with no tab is described by
// its write times, which only know that something wrote recently. The dot for that second case has
// to be drawn and has to say what it read. This reads the rows out of the live page and reports the
// state markers, so "did the background dot appear, and did it stay out of the way of a tab's
// reading" is a measurement rather than a reading of the source.
//
// Usage (dev instance with --remote-debugging-port=9222, the sessions panel showing):
//   node scripts/dev/probes/background-agent-dot.mjs
//   node scripts/dev/probes/background-agent-dot.mjs --match=http://localhost:1420/
//   node scripts/dev/probes/background-agent-dot.mjs --expect-background=2
//
// `--expect-background=N` fails the run when the number of rows marked `background` is not N.
// `--expect-active=<text>` fails the run when no row whose title contains <text> carries any mark:
// that is the assertion the write-time reading most needs, since the row it must catch is the one a
// command line cannot name.
// Exits 2 when the sessions panel is not on screen: nothing measured is not a pass.
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const match = arg("match") ?? "http://localhost:1420/";
const expectBackground = arg("expect-background");
const expectActive = arg("expect-active");

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

const rows = await evalIn(`
  const rows = [...document.querySelectorAll("[data-session-id]")];
  if (rows.length === 0) return null;
  return rows.map((row) => {
    const mark = row.querySelector("[data-agent-state]");
    const r = row.getBoundingClientRect();
    return {
      id: row.getAttribute("data-session-id"),
      title: (row.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 34),
      // No marker at all means no agent, which is a state too.
      state: mark ? mark.getAttribute("data-agent-state") : null,
      width: Math.round(r.width),
    };
  });
`);

if (!rows) {
  console.error("会话面板没开（找不到 [data-session-id]）：先把左栏切到「会话」再跑这个探针。");
  process.exit(2);
}
// A collapsed sidebar draws 16px-wide rows: the markers are all there, but nothing is on screen.
if (rows[0].width < 60) {
  console.error(`会话面板是收起的（行宽 ${rows[0].width}px）：先展开侧栏再跑。`);
  process.exit(2);
}

const counts = { attention: 0, working: 0, idle: 0, finished: 0, background: 0, none: 0 };
for (const row of rows) {
  const key = row.state ?? "none";
  counts[key] = (counts[key] ?? 0) + 1;
  console.log(`${row.state ?? "无点"}  ${row.id}  ${row.title}`);
}
console.log(
  `\n${rows.length} 行：蓝 ${counts.attention} · 橙(working) ${counts.working} · 绿(idle) ${counts.idle} ·` +
    ` 绿(finished) ${counts.finished} · 橙(background) ${counts.background} · 无点 ${counts.none}`,
);

const failures = [];
if (expectBackground !== null && counts.background !== Number(expectBackground)) {
  failures.push(`background 行数是 ${counts.background}，期望 ${expectBackground}`);
}
if (expectActive !== null) {
  const hit = rows.find((row) => row.title.includes(expectActive));
  if (!hit) failures.push(`没有标题包含「${expectActive}」的行`);
  else if (hit.state === null) failures.push(`「${expectActive}」那一行没有点（title: ${hit.title}）`);
}

if (failures.length === 0) {
  console.log("\n通过。");
  process.exit(0);
}
console.log("\n不通过：");
for (const line of failures) console.log(`  - ${line}`);
process.exit(1);