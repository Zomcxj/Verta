// Does the compact session details card *move* between rows?
//
// The point of the edge-dock reference that survives here: one card for the whole list, anchored to
// whichever row the pointer is on, moved by its transform. Switching rows must therefore reuse the
// same element - a card per row could only appear and disappear - with its transform changing, a
// transition long enough to see, the content replaced while the card keeps travelling, and nothing
// but transform and opacity involved.
//
//   node scripts/dev/probes/compact-card-roam.mjs [--port=9222]
const args = process.argv.slice(2);
const port = args.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {};
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(
  (t) =>
    t.type === "page" &&
    (t.url.endsWith("1420/") ||
      (t.url.includes("tauri.localhost") && !t.url.includes("settings.html"))),
);
if (!page) fail("没找到主窗口的 page 目标，应用起来了吗？");

const socket = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
const pending = new Map();
await new Promise((r) => socket.addEventListener("open", () => r()));
socket.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  const q = pending.get(m.id);
  if (!q) return;
  pending.delete(m.id);
  q(m);
});
const send = (method, params) =>
  new Promise((res, rej) => {
    const i = id++;
    pending.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    socket.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (body) => {
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
const move = (x, y) =>
  send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });

const PRESS = `
  const press = (el) => {
    const o = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...o, buttons: 0 }));
  };
`;

// The session list, in compact density, with the rows the card will be pointed at.
const rows = JSON.parse(
  await evaluate(`
  ${PRESS}
  if (document.querySelector("[data-session-id]") === null) {
    const rail = [...document.querySelectorAll("button[aria-label]")].find((b) => /会话|Sessions/.test(b.getAttribute("aria-label") ?? ""));
    if (rail) press(rail);
    await new Promise((r) => setTimeout(r, 2500));
  }
  const list = document.querySelector("[data-session-density]");
  if (!list) return JSON.stringify({ step: "no-session-list" });
  if (list.getAttribute("data-session-density") !== "compact") {
    return JSON.stringify({ step: "standard-density" });
  }
  const visible = [...document.querySelectorAll("[data-session-id]")].filter((el) => el.offsetParent !== null);
  return JSON.stringify({
    step: "rows",
    rows: visible.slice(0, 3).map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute("data-session-id"), x: Math.round(r.left + Math.min(80, r.width / 2)), y: Math.round(r.top + r.height / 2) };
    }),
  });
`),
);
report.rows = rows;
if (rows.step === "standard-density") {
  console.log(JSON.stringify(report, null, 2));
  console.log("SKIP: 会话列表不是紧凑密度，这一档没有详情卡可量。");
  process.exit(0);
}
if (rows.step !== "rows") fail(`会话列表没就绪：${rows.step}`);
if (rows.rows.length < 2) fail(`可见会话行少于 2，无法量"切换到下一行"：${JSON.stringify(rows.rows)}`);

/** The card as it is right now, plus the element identity a comparison needs. */
const readCard = () =>
  evaluate(`
    const el = document.querySelector("[data-compact-card]");
    if (!el) return JSON.stringify({ step: "none" });
    if (!window.__probeCard) window.__probeCard = el;
    const style = getComputedStyle(el);
    return JSON.stringify({
      step: "card",
      sameElement: window.__probeCard === el,
      transform: style.transform,
      transition: style.transitionProperty + " " + style.transitionDuration,
      ready: el.getAttribute("data-ready"),
      opacity: style.opacity,
      width: Math.round(el.getBoundingClientRect().width),
      filter: style.filter,
      willChange: style.willChange,
      body: (el.querySelector("[data-compact-card-body]")?.textContent ?? "").slice(0, 60),
      describedBy: [...document.querySelectorAll("[data-session-id]")].filter((row) => row.getAttribute("aria-describedby") === el.id).map((row) => row.getAttribute("data-session-id")),
    });
  `);

// --- the first row -------------------------------------------------------------------------------
await send("Page.bringToFront", {});
await move(700, 500);
await sleep(300);
await move(rows.rows[0].x, rows.rows[0].y);
await sleep(500);
const first = JSON.parse(await readCard());
report.first = first;
if (first.step !== "card") fail("第一行上没出现详情卡");
if (first.ready !== "true") fail(`卡片第一处落位没有置 data-ready：${first.ready}`);
if (first.opacity !== "1") fail(`卡片应当可见：opacity ${first.opacity}`);
// The engine hands back `matrix(a, b, c, d, tx, ty)`: what matters is that the placement is a
// translation rather than the element's static position.
const translation = (transform) => {
  const parts = transform.match(/matrix\(([^)]+)\)/)?.[1].split(",").map((n) => Number.parseFloat(n));
  if (!parts || parts.length !== 6) return null;
  return { x: parts[4], y: parts[5] };
};
const firstAt = translation(first.transform);
if (firstAt === null || (firstAt.x === 0 && firstAt.y === 0)) {
  fail(`卡片没有用 transform 定位：${first.transform}`);
}
if (first.filter !== "none") fail(`卡片加了滤镜：${first.filter}`);
// As wide as its content, capped: one fixed width - and a minimum width just as much - draws a card
// wider or narrower than the details in it. The bounds below are the 19rem cap plus the card's own
// horizontal padding, and a floor that only guards against a card too small to read.
const floor = 6 * 16;
const cap = 19 * 16 + 2 * 10 + 2;
if (!(first.width >= floor && first.width <= cap)) {
  fail(`卡片宽度 ${first.width}px 不在自适应的范围内（${floor}–${cap}px）`);
}
if (first.willChange !== "auto") fail(`卡片声明了 will-change：${first.willChange}`);
if (!first.transition.includes("transform")) fail(`卡片没有为 transform 声明过渡：${first.transition}`);
if (first.describedBy.length !== 1 || first.describedBy[0] !== rows.rows[0].id) {
  fail(`被描述的行不对：${JSON.stringify(first.describedBy)}，应是 ${rows.rows[0].id}`);
}

// --- the next row --------------------------------------------------------------------------------
await move(rows.rows[1].x, rows.rows[1].y);
await sleep(500);
const second = JSON.parse(await readCard());
report.second = second;
if (second.step !== "card") fail("换到下一行后卡片不见了");
if (!second.sameElement) fail("换行时换了一个元素：卡片是重新挂载的，不是在移动");
if (second.transform === first.transform) {
  fail(`换行后 transform 没变（${first.transform} → ${second.transform}），卡片没有跟着走`);
}
if (second.body === first.body) fail(`换行后内容没换：两行显示的都是 ${JSON.stringify(second.body)}`);
if (second.describedBy.length !== 1 || second.describedBy[0] !== rows.rows[1].id) {
  fail(`换行后被描述的行没跟着走：${JSON.stringify(second.describedBy)}`);
}

// The movement is vertical here: rows are stacked, so the card slides, it does not jump sideways.
const moved = Math.abs(
  (translation(second.transform)?.y ?? Number.NaN) - firstAt.y,
);
report.movedBy = moved;
if (!(moved > 2)) fail(`卡片纵向只移动了 ${moved}px，看不出在跟着行走`);

// --- the pointer leaving the list -----------------------------------------------------------------
await move(700, 500);
await sleep(400);
const away = JSON.parse(await readCard());
report.away = away;
if (away.step !== "none" && away.opacity !== "0") {
  fail(`指针离开列表后卡片还在（opacity ${away.opacity}）`);
}
if (away.step === "card" && away.transform !== first.transform) {
  // A card that is only faded out must not have travelled somewhere else meanwhile.
  fail("指针离开后卡片位置变了");
}

socket.close();
console.log(JSON.stringify(report, null, 2));
console.log(
  `PASS: 会话详情卡是列表里唯一的一张（同一 DOM），宽度自适应（实测 ${report.first.width}px→${report.second.width}px），换行时整体移动 ${report.movedBy}px、内容换新、被描述的行跟着走，指针离开后淡出；只动 transform/opacity，无滤镜无 will-change。`,
);
process.exit(0);
