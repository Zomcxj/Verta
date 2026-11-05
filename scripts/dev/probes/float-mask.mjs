// Do the three floating layers that carry their own text keep a background?
//
// A compact session's details, a file list's right-click menu and the choice list in settings follow
// the theme's pane opacity on the glass theme, which left their rows read through whatever was
// behind them - "全透明". They carry `verta-float-mask` now, and this measures what the engine
// actually computed: the popover colour at a fixed fraction, no blur.
//
//   node scripts/dev/probes/float-mask.mjs [--port=9222]
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
const mainPage = targets.find(
  (t) =>
    t.type === "page" &&
    (t.url.endsWith("1420/") ||
      (t.url.includes("tauri.localhost") && !t.url.includes("settings.html"))),
);
if (!mainPage) fail("没找到主窗口的 page 目标，应用起来了吗？");

/** A CDP session on one page, with the evaluation helper the probes share. */
async function connect(page) {
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
  return { socket, send, evaluate };
}

/**
 * The alpha of a computed `background-color`, as the engine resolved it. Three shapes have to be
 * read: `rgba(r, g, b, a)` from a plain class, `rgb(r, g, b)` for an opaque one, and
 * `color(srgb r g b / a)` - which is what a `color-mix()` resolves to, and the shape the first
 * version of this probe silently failed to parse, leaving it to "pass" on a null reading.
 */
const ALPHA = `
  const alphaOf = (el) => {
    const value = getComputedStyle(el).backgroundColor;
    const slash = value.match(/\\/\\s*([\\d.]+)(%?)\\s*\\)/);
    const rgb = value.match(/rgba?\\(([^)]+)\\)/);
    let alpha = null;
    if (slash) {
      alpha = Number.parseFloat(slash[1]);
      if (slash[2] === "%") alpha /= 100;
    } else if (rgb) {
      const parts = rgb[1].split(",").map((p) => Number.parseFloat(p));
      alpha = parts.length === 4 ? parts[3] : 1;
    } else if (/^(rgb|color)\\(/.test(value)) {
      alpha = 1;
    }
    return {
      color: value,
      alpha: alpha === null ? null : Number(alpha.toFixed(3)),
      masked: el.classList.contains("verta-float-mask"),
    };
  };
`;

const PRESS = `
  const press = (el) => {
    const o = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...o, buttons: 0 }));
  };
`;

const main = await connect(mainPage);

// The mask is a glass-theme rule, and the machine's theme may not be one: turn it on for the
// measurement and put the attribute back afterwards.
report.themeHadGlass = await main.evaluate(`
  const had = document.documentElement.hasAttribute("data-theme-glass");
  if (!had) document.documentElement.setAttribute("data-theme-glass", "");
  return had;
`);

// 1. The file list's right-click menu. The point is verified against the document first: a
// right-click that missed would "prove" that no menu opens.
report.contextMenu = JSON.parse(
  await main.evaluate(`
  ${ALPHA}
  ${PRESS}
  // The file tree is behind the sidebar's own "files" entry: a right-click menu is only there once it
  // is on screen.
  if ([...document.querySelectorAll("[data-fs-path]")].every((el) => el.offsetParent === null)) {
    const rail = [...document.querySelectorAll("button[aria-label]")].find((b) => /^文件$|^Files$/.test((b.getAttribute("aria-label") ?? "").trim()));
    if (rail) press(rail);
    await new Promise((res) => setTimeout(res, 1800));
  }
  const row = [...document.querySelectorAll("[data-fs-path]")].find((el) => el.offsetParent !== null);
  if (!row) return JSON.stringify({ step: "no-row" });
  const r = row.getBoundingClientRect();
  const x = Math.round(r.left + 20);
  const y = Math.round(r.top + r.height / 2);
  const hit = document.elementFromPoint(x, y);
  if (!hit || !(hit === row || row.contains(hit))) {
    return JSON.stringify({ step: "missed-row", hit: hit?.tagName ?? null });
  }
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
  await new Promise((res) => setTimeout(res, 800));
  const menu = document.querySelector("[data-slot=context-menu-content]");
  const reading = menu ? alphaOf(menu) : null;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise((res) => setTimeout(res, 400));
  return JSON.stringify({ step: menu ? "done" : "no-menu", ...(reading ?? {}) });
`),
);

// 2. A compact session's details. That popover only exists while the session list is in compact
// density, so its control in the settings window is used to put it there - and put back afterwards.
const settingsPage = targets.find(
  (t) => t.type === "page" && t.url.includes("settings.html"),
);
const settings = settingsPage ? await connect(settingsPage) : null;
if (settings) {
  const hadGlass = await settings.evaluate(`
    const had = document.documentElement.hasAttribute("data-theme-glass");
    if (!had) document.documentElement.setAttribute("data-theme-glass", "");
    return had;
  `);
  report.settingsThemeHadGlass = hadGlass;
}
// The row is hovered with the real cursor: a tooltip opens on pointer movement, and a dispatched
// event is not movement.
const compactSpot = await main.evaluate(`
  ${PRESS}
  if (document.querySelector("[data-session-id]") === null) {
    const rail = [...document.querySelectorAll("button[aria-label]")].find((b) => /会话|Sessions/.test(b.getAttribute("aria-label") ?? ""));
    if (rail) press(rail);
    await new Promise((res) => setTimeout(res, 2500));
  }
  const list = document.querySelector("[data-session-density]");
  if (!list) return JSON.stringify({ step: "no-session-list" });
  if (list.getAttribute("data-session-density") !== "compact") {
    return JSON.stringify({ step: "skipped-standard-density" });
  }
  const row = [...document.querySelectorAll("[data-session-id]")].find((el) => el.offsetParent !== null);
  if (!row) return JSON.stringify({ step: "no-session-rows" });
  const r = row.getBoundingClientRect();
  return JSON.stringify({ step: "row", x: Math.round(r.left + Math.min(80, r.width / 2)), y: Math.round(r.top + r.height / 2) });
`);
report.compactSpot = JSON.parse(compactSpot);
if (report.compactSpot.step === "row") {
  await main.send("Page.bringToFront", {});
  await main.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: report.compactSpot.x - 30, y: report.compactSpot.y, button: "none", buttons: 0 });
  await sleep(150);
  await main.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: report.compactSpot.x, y: report.compactSpot.y, button: "none", buttons: 0 });
  await sleep(1600);
  report.compactDetails = JSON.parse(
    await main.evaluate(`
    ${ALPHA}
    const el = document.querySelector("[data-compact-card]");
    const reading = el ? alphaOf(el) : null;
    return JSON.stringify({ step: el ? "done" : "no-popup", ...(reading ?? {}) });
  `),
  );
} else {
  report.compactDetails = report.compactSpot;
}

// 3. The choice list of a select, in the settings window, which is its own document.
if (!settings) {
  report.selectMenu = { step: "no-settings-window" };
} else {
  report.selectMenu = JSON.parse(
    await settings.evaluate(`
    ${ALPHA}
    const trigger = [...document.querySelectorAll("[data-slot=select-trigger]")].find((el) => {
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && el.offsetParent !== null;
    });
    if (!trigger) return JSON.stringify({ step: "no-select" });
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse" }));
    trigger.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, buttons: 0, pointerId: 1, pointerType: "mouse" }));
    trigger.click();
    await new Promise((res) => setTimeout(res, 900));
    const content = document.querySelector("[data-slot=select-content]");
    const reading = content ? alphaOf(content) : null;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((res) => setTimeout(res, 400));
    return JSON.stringify({ step: content ? "done" : "no-content", ...(reading ?? {}) });
  `),
  );
  await settings.evaluate(`
    if (!${report.settingsThemeHadGlass}) document.documentElement.removeAttribute("data-theme-glass");
    return null;
  `);
  settings.socket.close();
}

// Put the theme attribute back the way it was found.
if (report.themeHadGlass === false) {
  await main.evaluate(`
    document.documentElement.removeAttribute("data-theme-glass");
    return null;
  `);
}
main.socket.close();

console.log(JSON.stringify(report, null, 2));

// A reading that did not happen fails the probe: "could not tell" is not "the mask is there".
const problems = [];
for (const [label, reading] of [
  ["文件列表右键菜单", report.contextMenu],
  ["会话详情卡", report.compactDetails],
  ["设置选择列表", report.selectMenu],
]) {
  if (reading.step === "skipped-standard-density") continue;
  if (reading.step !== "done") {
    problems.push(`${label}没开出来：${reading.step}`);
    continue;
  }
  if (!reading.masked) problems.push(`${label}没带 verta-float-mask`);
  if (reading.alpha === null || reading.alpha === undefined) {
    problems.push(`${label}的底色没读出 alpha（${reading.color ?? "无"}）`);
    continue;
  }
  if (reading.alpha < 0.8) problems.push(`${label}仍是 ${reading.alpha} 透明`);
}
if (problems.length > 0) fail(problems.join("；"));

console.log("PASS: 三类带文字的浮层都带蒙版底色（alpha ≥ 0.8），不是全透明，也没有加模糊。");
process.exit(0);
