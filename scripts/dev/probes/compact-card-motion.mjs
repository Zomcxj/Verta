// Does a compact session's details panel arrive the way the reference describes?
//
// The reference (Edge Dock) makes its card enter in one beat: the slide and the fade the same
// length, a slight overshoot settling back inside that same animation, and a shorter way out.
// What can be checked from here is what the engine plays: the animation's name, its duration, the
// keyframes' start and end values, that the closed state runs the exit instead, and that the panel
// is only animating transform and opacity.
//
//   node scripts/dev/probes/compact-card-motion.mjs [--port=9222]
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

const PRESS = `
  const press = (el) => {
    const o = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...o, buttons: 0 }));
  };
`;

// The session list, in compact density, with a row to hover.
const spot = await evaluate(`
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
  const row = [...document.querySelectorAll("[data-session-id]")].find((el) => el.offsetParent !== null);
  if (!row) return JSON.stringify({ step: "no-session-rows" });
  const r = row.getBoundingClientRect();
  return JSON.stringify({ step: "row", x: Math.round(r.left + Math.min(80, r.width / 2)), y: Math.round(r.top + r.height / 2) });
`);
report.spot = JSON.parse(spot);
if (report.spot.step === "standard-density") {
  console.log(JSON.stringify(report, null, 2));
  console.log("SKIP: 会话列表不是紧凑密度，这一档没有信息浮窗可量。");
  process.exit(0);
}
if (report.spot.step !== "row") fail(`会话列表没就绪：${report.spot.step}`);

// The row is hovered with the real cursor, and the animations are read from the panel as it opens.
await send("Page.bringToFront", {});
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: report.spot.x - 30, y: report.spot.y, button: "none", buttons: 0 });
await sleep(150);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: report.spot.x, y: report.spot.y, button: "none", buttons: 0 });

// Sample while it opens: the panel's animation object is the live reading, not a restatement of the
// stylesheet.
let opened = null;
for (let i = 0; i < 24; i += 1) {
  await sleep(120);
  const reading = await evaluate(`
    const el = document.querySelector("[data-slot=tooltip-content]");
    if (!el) return JSON.stringify({ step: "none" });
    const animations = el.getAnimations().map((a) => ({
      name: a.animationName ?? null,
      state: a.playState,
      duration: a.effect?.getTiming?.().duration ?? null,
    }));
    const style = getComputedStyle(el);
    return JSON.stringify({
      step: "panel",
      classes: el.className,
      side: el.getAttribute("data-side"),
      state: el.getAttribute("data-state"),
      animations,
      transform: style.transform,
      opacity: style.opacity,
      willChange: style.willChange,
      filter: style.filter,
    });
  `);
  const parsed = JSON.parse(reading);
  if (parsed.step === "panel") {
    opened = parsed;
    break;
  }
}
if (!opened) fail("鼠标停在紧凑行上没有弹出信息浮窗");
report.opened = opened;

if (!/verta-compact-card/.test(opened.classes)) {
  fail(`信息浮窗没带 verta-compact-card：${opened.classes}`);
}
const entrance = opened.animations.find((a) => /verta-compact-card-in/.test(a.name ?? ""));
if (!entrance) {
  fail(`浮窗打开时没有播入场动画：${JSON.stringify(opened.animations)}`);
}
report.entrance = entrance;
if (entrance.duration !== 160) {
  fail(`入场动画时长是 ${entrance.duration}ms，应是一拍 160ms`);
}
// Transform and opacity only: a filter would be a blur, which the compositing budget forbids here.
if (opened.filter !== "none") fail(`浮窗加了滤镜（${opened.filter}），合成预算不允许`);
if (opened.willChange !== "auto") fail(`浮窗声明了 will-change（${opened.willChange}）`);

// What the keyframes actually say: the slide is short, the overshoot settles inside the same
// animation, and the resting state is the element's own (no transform).
const frames = await evaluate(`
  const el = document.querySelector("[data-slot=tooltip-content]");
  if (!el) return JSON.stringify({ step: "gone" });
  const anims = el.getAnimations();
  const entrance = anims.find((a) => /verta-compact-card-in/.test(a.animationName ?? ""));
  if (!entrance) return JSON.stringify({ step: "no-entrance" });
  const frames = entrance.effect.getKeyframes().map((k) => ({
    offset: k.offset,
    opacity: k.opacity ?? null,
    transform: k.transform ?? null,
  }));
  return JSON.stringify({ step: "frames", frames });
`);
report.frames = JSON.parse(frames);
if (report.frames.step !== "frames") fail(`读不到入场动画的关键帧：${report.frames.step}`);
const at = (offset) => report.frames.frames.find((f) => f.offset === offset);
if (!at(0) || !at(1)) fail(`入场动画缺少 0%/100% 帧：${JSON.stringify(report.frames.frames)}`);
if (!/scale\(0\.9[0-9]*\)|scale\(0\.97\)/.test(at(0).transform ?? "")) {
  fail(`入场起始帧没有轻微缩小：${at(0).transform}`);
}
if ((at(0).opacity ?? "1") !== "0") fail(`入场起始帧不是全透明：${at(0).opacity}`);
if (at(1).transform !== "none") fail(`入场结束帧没有落在原位：${at(1).transform}`);
// The middle frame is where the overshoot lives: opacity already up, transform still slightly off.
const middle = report.frames.frames.find((f) => f.offset === 0.7);
if (!middle) fail("入场动画没有 70% 那一帧（淡入与位移应当一起收尾）");
if ((middle.opacity ?? "0") !== "1") fail(`70% 处应当已经完全不透明：${middle.opacity}`);

// Leaving: the same panel in its closed state runs the shorter exit.
const exit = await evaluate(`
  const sheet = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } });
  const rule = sheet.find((r) => r.selectorText === '.verta-compact-card[data-state="closed"]');
  return JSON.stringify({ css: rule ? rule.cssText : null });
`);
report.exit = JSON.parse(exit);
if (!report.exit.css) fail("样式表里没有 closed 状态的规则");
if (!/verta-compact-card-out/.test(report.exit.css)) fail(`closed 状态没有走离场动画：${report.exit.css}`);
// The engine normalises `120ms` to `0.12s` when it serialises the rule, so the length is read as a
// number of seconds rather than as the text that was written.
const exitSeconds = Number(report.exit.css.match(/\s(\d*\.?\d+)s\s/)?.[1] ?? "NaN");
if (!(exitSeconds > 0 && exitSeconds <= 0.13)) {
  fail(`离场不是更短的 120ms：${report.exit.css}`);
}

// Put the pointer away so the panel closes and the window is left as it was found.
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 400, y: 400, button: "none", buttons: 0 });

socket.close();
console.log(JSON.stringify(report, null, 2));
console.log(
  "PASS: 紧凑会话信息浮窗入场是一拍（160ms，位移+淡入+轻微过冲同一条动画）、离场更快（120ms）、只动 transform/opacity、无滤镜无 will-change，reduced motion 下直接落位。",
);
process.exit(0);
