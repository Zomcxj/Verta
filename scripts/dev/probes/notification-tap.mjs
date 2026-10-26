// Does a session that starts waiting behind another tab get announced, and is the raise the
// click uses wired?
//
// The notification itself cannot be read from inside the page. On Windows only an installed
// app's notification carries its own name, so in development it shows PowerShell's, and the
// click comes back through a channel the plugin keeps in Rust - a page cannot feed that one,
// so the composition "click -> raise the window -> go to the session" is accepted on the
// installed build, and what is pinned here is everything around it:
//
//  1. a terminal is opened and left waiting on a question, with another tab in front of it;
//  2. the judge has to report it as waiting without anyone looking at it - the tab's own dot
//     proves the screen was read, and the bell's list is the latch the notification is made
//     from;
//  3. the page's console is collected throughout, because a notification that failed to be
//     sent says so there (the layer logs it rather than throwing);
//  4. the command a click calls to bring the window back is called, so a raise that is not
//     wired is a failure here and not in front of the user;
//  5. looking at the wait clears the latch, and the bell with it.
//
// What the click itself rests on is unit-tested: the payload it reads (`tappedPty`) and the
// tab it then goes to (`tabForPty`).
//
// The user's active tab is put back and the probe's tab closed, so the window is left as it
// was found.
//
// Usage: node scripts/dev/probes/notification-tap.mjs
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) {
  console.error("dev 起来了？没找到主窗口的 page 目标。");
  process.exit(1);
}
const socket = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
const pending = new Map();
const consoleLines = [];
await new Promise((r) => socket.addEventListener("open", () => r()));
socket.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.consoleAPICalled") {
    const text = (m.params.args ?? [])
      .map((a) => {
        if (a.value !== undefined) return String(a.value);
        if (a.description !== undefined) return a.description;
        if (a.preview?.description) return a.preview.description;
        return `[${a.type}]`;
      })
      .join(" ");
    consoleLines.push({ type: m.params.type, at: Date.now(), text });
    return;
  }
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
const pageEval = async (body) => {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => {\n${body}\n})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(
      r.result.exceptionDetails.exception?.description ??
        r.result.exceptionDetails.text,
    );
  }
  return r.result.result.value;
};

const PRESS = `
  window.__probe = window.__probe || {};
  window.__probe.press = (node) => {
    const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
    node.dispatchEvent(new PointerEvent("pointerdown", opts));
    node.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
    node.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
  };
  var press = window.__probe.press;
`;

const MODULES = `
  const urls = performance.getEntriesByType("resource").map((e) => e.name);
  const find = (p) => { const hits = urls.filter((n) => n.includes("/src/" + p)); return hits.find((n) => n.includes("?t=")) ?? hits[0] ?? ("/src/" + p); };
  const api = await import(find("modules/terminal/lib/terminalSessionApi.ts"));
  const sessions = await import(find("modules/terminal/ghostty/useGhosttyTerminalSession.ts"));
  const activity = await import(find("modules/terminal/lib/agentActivity.ts"));
`;

/** The bell and its count, which tab is in front, and what the store thinks. */
const state = () =>
  pageEval(`
    ${MODULES}
    const store = activity.useAgentActivityStore.getState();
    const bell = document.querySelector("[data-agent-bell]");
    const count = document.querySelector("[data-agent-bell-count]");
    const active = [...document.querySelectorAll("[role=tab]")].find((t) => t.getAttribute("data-tab-active") === "true");
    return JSON.stringify({
      bell: bell ? (count ? (count.textContent || "").trim() : "0") : null,
      activeTab: active ? active.getAttribute("data-tab-id") : null,
      activeLabel: active ? (active.textContent || "").trim() : null,
      dots: [...document.querySelectorAll("[role=tab] [data-agent-state]")].map((d) => d.getAttribute("data-agent-state")),
      phases: store.phases,
      unseen: store.unseen,
      leafPty: store.leafPty,
    });
  `).then(JSON.parse);

const activate = (tabId) =>
  pageEval(`
    const tab = [...document.querySelectorAll("[role=tab]")].find((n) => n.getAttribute("data-tab-id") === ${JSON.stringify(String(tabId))});
    if (!tab) return "not-found";
    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    tab.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" }));
    tab.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, buttons: 0, isPrimary: true, pointerId: 1, pointerType: "mouse" }));
    tab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    return "activated";
  `);

// pi's own screens, written from the captures the rules were made from. The rule line is what
// identifies the family, and it has to be inside the rows the rules read.
const PI_RULE = "─".repeat(124);
const PI_WORKING = [
  'clear',
  `printf '用一句话说明 notes.txt 里写了什么\\n── ⠙ Working ─────────────────────────────────────────────────────────────\\n${PI_RULE}\\n~/AppData/Local/Temp/verta-pi-probe\\n1.6%%/262k (auto)                     (sensenova) sensenova-6.8-flash-lite • medium\\n'`,
].join(" ; ");
const PI_BLOCKED = [
  'clear',
  `printf ' 删除文件选择\\n 该删掉 a.txt 还是 b.txt？\\n → 删掉 a.txt — 移除 a.txt，保留 b.txt\\n   删掉 b.txt — 移除 b.txt，保留 a.txt\\n   Other (type your answer)\\n ↑↓ navigate  enter select  escape/ctrl+c cancel\\n${PI_RULE}\\n ↳ 请再用 ask_user 工具问我：该删掉 a.txt 还是 b.txt？\\n'`,
].join(" ; ");

const write = (leaf, command) =>
  pageEval(`
    ${MODULES}
    return api.writeToSession(${leaf}, ${JSON.stringify(`${command}\r`)});
  `);

const report = {};
let probeTabId = null;
try {
  await send("Runtime.enable");
  await send("Page.bringToFront");
  await sleep(800);
  // A freshly started window restores its own tabs a moment later, and that can take the
  // probe's new one with it: wait for the session to settle before touching anything.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const open = await pageEval(
      `return document.querySelectorAll("[role=tab]").length;`,
    );
    if (typeof open === "number" && open > 0) break;
    await sleep(500);
  }
  await sleep(1500);
  const before = await state();
  report.before = before;

  // A terminal of the probe's own, in front - the user's own tabs are left alone.
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    modifiers: 2,
    key: "t",
    code: "KeyT",
    windowsVirtualKeyCode: 84,
    nativeVirtualKeyCode: 84,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 2,
    key: "t",
    code: "KeyT",
    windowsVirtualKeyCode: 84,
    nativeVirtualKeyCode: 84,
  });

  const known = new Set(
    JSON.parse(
      await pageEval(`
        ${MODULES}
        return JSON.stringify(sessions.ghosttySessionDiagnostics().map((s) => s.leafId));
      `),
    ),
  );
  let leaf = null;
  for (let attempt = 0; attempt < 40 && leaf === null; attempt += 1) {
    await sleep(500);
    const now = JSON.parse(
      await pageEval(`
        ${MODULES}
        return JSON.stringify(sessions.ghosttySessionDiagnostics().map((s) => s.leafId));
      `),
    );
    leaf = now.find((l) => !known.has(l)) ?? null;
  }
  if (leaf === null) throw new Error("新会话没起来");
  report.leaf = leaf;
  probeTabId = (await state()).activeTab;

  let ready = false;
  for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
    await sleep(500);
    ready =
      (
        await pageEval(`
          ${MODULES}
          return api.leafScreenTail(${leaf}) ?? "";
        `)
      ).trim().length > 0;
  }
  if (!ready) throw new Error("shell 没起来");

  // Meanwhile, someone else's tab in front: this is the case the slice is about.
  if (before.activeTab !== null) await activate(before.activeTab);
  await sleep(1200);

  // The judge reads this terminal at all - without that, nothing below means anything.
  await write(leaf, PI_WORKING);
  await sleep(2000);
  report.working = await state();

  const mark = Date.now();
  await write(leaf, PI_BLOCKED);
  await sleep(3500);
  report.waiting = await state();
  report.console = consoleLines.filter((line) => line.at >= mark);

  const pty = Object.entries(report.waiting.leafPty).find(
    ([leafId]) => Number(leafId) === leaf,
  )?.[1];
  report.pty = pty ?? null;

  // The command a click calls: a raise that is not wired is a failure here rather than in
  // front of the user.
  report.focusCommand = await pageEval(`
    return await window.__TAURI_INTERNALS__.invoke("tray_focus_main").then(() => "ok", (e) => "err:" + e);
  `);

  // Looking at it is what clears the latch, and the bell with it.
  if (probeTabId !== null) await activate(probeTabId);
  await sleep(2000);
  report.afterLooking = await state();
  report.consoleAfter = consoleLines.filter((line) => line.at >= mark);
} catch (error) {
  report.error = String(error?.message ?? error);
}

// Put everything back, whatever happened above.
try {
  if (report.before?.activeTab != null) await activate(report.before.activeTab);
  await sleep(500);
  if (probeTabId !== null) {
    await pageEval(`
      ${PRESS}
      const tab = [...document.querySelectorAll("[role=tab]")].find((n) => n.getAttribute("data-tab-id") === ${JSON.stringify(String(probeTabId))});
      const close = tab?.querySelector("[data-no-drag][role=button]");
      if (!close) return "no-close-control";
      press(close);
      return "pressed";
    `);
    await sleep(600);
  }
  report.afterClose = await state();
} catch (error) {
  report.cleanupError = String(error?.message ?? error);
}
console.log(JSON.stringify(report, null, 1));
socket.close();
