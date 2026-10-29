// What a session row draws in each density, and what a compact row's popup says.
//
// A row's density is a fact about a rendered panel, not about a function: how many lines it
// takes, whether the browser's own title tooltip is still attached, and - in the compact case -
// whether hovering really produces a popup, whether that popup's three parts stack, and whether
// the row still opens a session. The last two are the ones that break silently: two triggers
// sitting on one element is the arrangement that decides them, and neither the stylesheet nor a
// unit test can see it.
//
// It reads the density from the marker the list carries rather than counting lines and guessing,
// and it fails loudly when the sessions list is not on screen: a probe that finds no rows has
// measured nothing, and reporting that as a pass is how a feature ships broken.
//
// Usage:
//   node scripts/dev/probes/session-list-density.mjs --match=http://tauri.localhost/ --expect=standard
//   node scripts/dev/probes/session-list-density.mjs --match=http://tauri.localhost/ --expect=compact --hover
//   node scripts/dev/probes/session-list-density.mjs --match=http://tauri.localhost/ --hover --click-row
//
// Name the window exactly. The settings page is served from the same origin, so `tauri.localhost/`
// matches both it and the window with the list on it, and the first of the two the debugger lists
// wins - measured: a run that thought it was reading a standard list was reading the settings page,
// which has no list at all.
//
// `--expect=standard|compact` asserts the drawn density and its consequences: a standard row is
// two lines, keeps its `title`, and produces no popup on hover; a compact row is one line, has no
// `title`, and produces exactly one popup that says three things.
//
// `--hover` puts the pointer on the first row's centre for real (a synthesized event is not what a
// tooltip listens for) and reads what appeared. `--click-row` presses and releases there, then
// reports the tab count before and after, which is the only honest way to know the row still
// works with a popup attached to it.
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const match = arg("match");
const expect = arg("expect");
const hover = process.argv.includes("--hover");
const clickRow = process.argv.includes("--click-row");
// Every density's consequence that matters is about hovering - a standard row produces no popup, a
// compact one exactly one - so a run that checks a density without hovering would report a pass on a
// build where either of those is broken.
if (expect !== null && !hover) {
  console.error("--expect 必须和 --hover 一起用（每种密度的判定都落在悬停上）");
  process.exit(2);
}
if (expect !== null && expect !== "standard" && expect !== "compact") {
  console.error(`--expect must be standard or compact (got ${expect})`);
  process.exit(2);
}

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => {
  if (t.type !== "page") return false;
  if (match === null) return t.url.endsWith("1420/") || t.url.endsWith("tauri.localhost/");
  return match.endsWith("/") ? t.url.endsWith(match) : t.url.includes(match);
});
if (!page) {
  console.error("没找到主窗口的 page 目标（dev 或装机版起了吗？--match 对吗？）");
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
  new Promise((res, rej) => {
    const i = id++;
    pending.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    socket.send(JSON.stringify({ id: i, method, params }));
  });
const pageEval = async (body) => {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => {\n${body}\n})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Everything the checks below read, in one pass: the list, its rows, the popups present. */
const readScreen = () =>
  pageEval(`
    const list = document.querySelector("[data-session-density]");
    const rows = [...document.querySelectorAll("[data-session-id]")].map((row) => {
      const r = row.getBoundingClientRect();
      return {
        title: (row.textContent || "").trim().split("\\n")[0].slice(0, 32),
        meta: row.querySelectorAll("[data-session-meta]").length,
        nativeTitle: row.getAttribute("title"),
        lines: new Set(
          [...row.querySelectorAll("*")].map((el) => Math.round(el.getBoundingClientRect().top))
        ).size,
        centre: [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]
      };
    });
    const popups = [...document.querySelectorAll('[data-slot="tooltip-content"]')].map((p) => {
      const s = getComputedStyle(p);
      return {
        text: (p.textContent || "").trim(),
        lines: [...p.children].map((c) => (c.textContent || "").trim()),
        direction: s.flexDirection,
        height: Math.round(p.getBoundingClientRect().height)
      };
    });
    return JSON.stringify({
      density: list?.getAttribute("data-session-density") ?? null,
      listFound: list !== null,
      tabs: document.querySelectorAll("[data-tab-id]").length,
      rows,
      popups
    });
  `);

const before = JSON.parse(await readScreen());
if (!before.listFound || before.rows.length === 0) {
  console.error(
    "会话列表没在屏幕上（marker " +
      (before.listFound ? "在" : "不在") +
      "，行数 " +
      before.rows.length +
      "）：先从左栏打开「会话」列表再跑这个探针",
  );
  process.exit(1);
}

console.log(`画出来的密度：${before.density}`);
console.log(`标签数：${before.tabs}`);
for (const row of before.rows.slice(0, 5)) {
  console.log(
    `  行「${row.title}」可换行数元素 ${row.lines}，数字行 ${row.meta} 个，原生 title ${
      row.nativeTitle === null ? "没有" : `「${row.nativeTitle}」`
    }`,
  );
}
console.log(`悬停前的悬浮窗：${before.popups.length} 个`);

const first = before.rows[0];
let after = before;
if (hover) {
  // A tooltip opens on a real pointer move: a synthesized pointerover event is not what it
  // listens for, the same reason the file tree's menu needs a real contextmenu.
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: first.centre[0],
    y: first.centre[1],
  });
  // Read while the pointer is still on the row. Radix closes the popup as soon as the pointer
  // leaves, and pointing it somewhere else to evaluate is exactly that: the first run of this
  // probe reported "no popup" for a popup that had opened.
  await sleep(500);
  after = JSON.parse(await readScreen());
  console.log(`\n悬停后：${after.popups.length} 个悬浮窗`);
  for (const popup of after.popups) {
    console.log(`  方向 ${popup.direction}，高 ${popup.height}px`);
    for (const line of popup.lines) console.log(`    ${line}`);
  }
}

let clicked = null;
/**
 * The last reading taken for a judgement. Pressing a row opens a session, which can hide the panel,
 * so this is not always `after` - and a reading with no list in it, judged as "0 rows all correct",
 * is exactly how a probe reports a pass on a build it never looked at.
 */
let judged = after;
if (clickRow) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", {
      type,
      x: first.centre[0],
      y: first.centre[1],
      button: "left",
      clickCount: 1,
    });
  }
  await sleep(1500);
  const settled = JSON.parse(await readScreen());
  clicked = { before: after.tabs, after: settled.tabs };
  console.log(`\n点那一行：标签 ${clicked.before} → ${clicked.after}`);
  // The density and the row shapes were read before the press, while the list was certainly there.
  if (settled.listFound) judged = settled;
  else console.log("（点开会话后列表收了回去，密度与行形状用点之前的读数）");
}

const failures = [];
if (expect !== null && judged.density !== expect) {
  failures.push(`密度是 ${judged.density}，不是 --expect 的 ${expect}`);
}
if (judged.rows.length === 0) {
  failures.push("一行都没读到：这一轮什么都没量到，不能算通过");
}

for (const row of judged.rows) {
  if (expect === "compact" || judged.density === "compact") {
    if (row.meta !== 0) failures.push(`「${row.title}」是紧凑行却还有 ${row.meta} 条数字行`);
    if (row.nativeTitle !== null) {
      failures.push(`「${row.title}」是紧凑行却还挂着原生 title（会和悬浮窗叠着弹两层）`);
    }
  }
  if (expect === "standard" || judged.density === "standard") {
    if (row.meta !== 1) failures.push(`「${row.title}」是标准行却没有那一条数字行`);
    if (row.nativeTitle === null) failures.push(`「${row.title}」的标准行丢了原生 title`);
  }
}

if (hover) {
  if (after.density === "compact") {
    if (after.popups.length !== 1) {
      failures.push(`紧凑行悬停后有 ${after.popups.length} 个悬浮窗，应该恰好一个`);
    }
    for (const popup of after.popups) {
      if (popup.lines.length !== 3) {
        failures.push(`悬浮窗有 ${popup.lines.length} 段，应给标题、那三个数、目录三段`);
      }
      if (popup.direction !== "column") {
        failures.push(`悬浮窗没有竖排（flex-direction: ${popup.direction}），三句话会挤在一行`);
      }
      const numbers = popup.lines[1] ?? "";
      if ((numbers.match(/·/g) ?? []).length !== 2) {
        failures.push(`悬浮窗里那行数不是三段：${numbers}`);
      }
      const where = popup.lines[2] ?? "";
      if (!/^([A-Za-z]:\/|[/\\]|\\\\|\/mnt\/|\/home\/)/.test(where)) {
        failures.push(`悬浮窗最后一段不像目录：${where}`);
      }
    }
  } else if (after.popups.length !== 0) {
    // Not "no more than before": a popup already on screen and one opened by this hover are the same
    // failure, and the standard density is the one everybody sees.
    failures.push(`标准行悬停后有 ${after.popups.length} 个悬浮窗（缺省模式不该挂它）`);
  }
}

if (clickRow && clicked && clicked.after <= clicked.before) {
  failures.push(`点那一行没能开出一个会话（标签 ${clicked.before} → ${clicked.after}）`);
}

if (failures.length === 0) {
  console.log(`\n通过：${judged.density} 的列表，${judged.rows.length} 行都对得上。`);
  process.exit(0);
}
console.log("\n不通过：");
for (const line of failures) console.log(`  - ${line}`);
process.exit(1);
