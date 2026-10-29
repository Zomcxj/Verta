// Which parts of a remote repository row open the runs panel.
//
// The rule is about where a click lands: the CI column's own button opens the panel, nothing else on
// the row does. A row-wide click is invisible in the source once the handler is removed - the browser's
// pointer cursor and a click that produces a panel are what actually say it is gone - so this presses
// the name column and then the CI button, and reports what each produced.
//
// Usage:
//   node scripts/dev/probes/remote-row-click.mjs --match=http://tauri.localhost/
//   node scripts/dev/probes/remote-row-click.mjs --match=http://tauri.localhost/ --name=LabelForge
//
// The remote list has to be the one on screen (the projects panel, with "远程仓库" selected) and its CI
// column filled in; a row still saying "未检查" has to be checked first, which hovering does.
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const match = arg("match") ?? "http://tauri.localhost/";
const wantName = arg("name") ?? "LabelForge";

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
const panels = () => evalIn(`return document.querySelectorAll("[data-slot=dialog-content]").length;`);
const press = async (x, y) => {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
};

/** The row's name cell and its CI button, plus the cursor the row itself asks for. */
const spot = await evalIn(`
  const table = [...document.querySelectorAll("table")].find((t) =>
    /^仓库归属可见性.*CI/.test((t.querySelector("thead")?.textContent || "").replace(/\\s+/g, " "))
  );
  if (!table) return { found: false, why: "远程仓库那张表不在屏幕上" };
  const row = [...table.querySelectorAll("tbody tr")].find((tr) =>
    (tr.textContent || "").includes(${JSON.stringify(wantName)})
  );
  if (!row) return { found: false, why: "没有这一行", rows: table.querySelectorAll("tbody tr").length };
  const name = row.querySelector("td")?.getBoundingClientRect();
  const ci = [...row.querySelectorAll("button")].find((b) =>
    /通过|失败|未检查|检查中|没有 CI/.test((b.textContent || "").trim())
  );
  const c = ci?.getBoundingClientRect();
  return {
    found: true,
    cursor: getComputedStyle(row).cursor,
    nameAt: name ? [Math.round(name.left + 20), Math.round(name.top + name.height / 2)] : null,
    ciAt: c ? [Math.round(c.left + c.width / 2), Math.round(c.top + c.height / 2)] : null,
    ciLabel: ci ? (ci.textContent || "").trim() : null
  };
`);

if (!spot.found) {
  console.error(`量不到：${spot.why}（切到「远程仓库」再跑）`);
  process.exit(2);
}
console.log(`行「${wantName}」：cursor=${spot.cursor}，CI 格=${spot.ciLabel ?? "(没有)"}`);

const failures = [];
if (spot.cursor === "pointer") {
  failures.push('那一行还是 pointer 光标，等于还在告诉人"整行可点"');
}

// 1) The name column must not open anything.
//
// Nothing may be open first: a panel left over from an earlier run puts a `fixed inset-0` overlay over
// the whole window, and a press then lands on that overlay rather than on the row - measured: a run
// that read "the name column opened a panel" was pressing the overlay of a panel that was already up,
// and the press did nothing at all.
const alreadyOpen = await panels();
if (alreadyOpen !== 0) {
  console.error(`先关掉开着的 ${alreadyOpen} 个面板再跑：它们的遮罩会把点击吞掉，量到的不是那一行。`);
  process.exit(2);
}
if (spot.nameAt) {
  await press(spot.nameAt[0], spot.nameAt[1]);
  await sleep(2500);
  const after = await panels();
  console.log(`点名字那列之后：${after} 个面板`);
  if (after !== 0) failures.push(`点名字那列打开了 ${after} 个面板`);
  // The row re-checks on hover, so give the CI column time to settle before pressing it: a press
  // that lands mid-check hits a disabled button and opens nothing.
  await sleep(1500);
}

// 2) The CI button must open the runs panel.
if (!spot.ciAt) {
  failures.push("那一行没有 CI 格可点，这一半没量到");
} else {
  await press(spot.ciAt[0], spot.ciAt[1]);
  await sleep(3500);
  const after = await panels();
  const title = await evalIn(`
    const dlg = document.querySelector("[data-slot=dialog-content]");
    return dlg ? (dlg.textContent || "").replace(/\\s+/g, " ").slice(0, 60) : null;
  `);
  console.log(`点 CI 那格之后：${after} 个面板「${title ?? ""}」`);
  if (after === 0) failures.push("点 CI 那格没打开运行记录");
}

if (failures.length === 0) {
  console.log("\n通过：只有 CI 那格能开运行记录，名字那列点不动。");
  process.exit(0);
}
console.log("\n不通过：");
for (const line of failures) console.log(`  - ${line}`);
process.exit(1);
