// Does the notification list actually collect what is waiting, and does clicking an
// item take the user there?
//
// This is plan two's funnel: the tab marker says "one of these", the list says which
// ones and what they are asking. It opens a terminal of its own, leaves it waiting
// while another tab is in front, and then reads the header for the bell, the panel
// for the row, and the strip for the jump. The user's active tab is put back and the
// probe's tab closed, so the window is left as it was found.
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
`;

/** The bell and its panel, plus which tab is in front. */
const header = () =>
  pageEval(`
    const bell = document.querySelector("[data-agent-bell]");
    const count = document.querySelector("[data-agent-bell-count]");
    const menu = document.querySelector("[role=menu]");
    return JSON.stringify({
      bell: bell ? { title: bell.getAttribute("title"), count: count ? (count.textContent || "").trim() : null } : null,
      panel: menu
        ? {
            rows: [...menu.querySelectorAll("button")].map((row) => ({
              title: row.getAttribute("title"),
              text: (row.textContent || "").trim()
            }))
          }
        : null,
      activeTab: [...document.querySelectorAll("[role=tab]")].find((tab) => tab.getAttribute("data-tab-active") === "true")?.getAttribute("data-tab-id") ?? null
    });
  `);

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

const report = {};
const SCREEN_BLOCKED =
  'clear ; echo "△ Permission required" ; echo "  Allow once" ; echo "ctrl+p commands   · Tokens 12.4k"';

try {
  await send("Page.bringToFront");
  await sleep(600);
  const before = JSON.parse(await header());
  report.activeBefore = before.activeTab;
  report.headerBefore = before;

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
  const probeTabId = JSON.parse(await header()).activeTab;
  report.probeTabId = probeTabId;

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

  // Nothing waiting: no bell at all.
  await sleep(1500);
  report.atPrompt = JSON.parse(await header());

  // Go elsewhere, then let it start waiting.
  await activate(report.activeBefore);
  await sleep(1200);
  await pageEval(`
    ${MODULES}
    return api.writeToSession(${leaf}, ${JSON.stringify(`${SCREEN_BLOCKED}\r`)});
  `);
  await sleep(2500);
  report.waiting = JSON.parse(await header());

  // Open the list.
  report.openBell = await pageEval(`
    ${PRESS}
    const bell = document.querySelector("[data-agent-bell]");
    if (!bell) return "no-bell";
    press(bell);
    return "pressed";
  `);
  await sleep(900);
  report.panelOpen = JSON.parse(await header());

  // Jump: the probe's tab must come to the front, and the item must leave the list
  // because looking at it is what clears the latch.
  report.jump = await pageEval(`
    ${PRESS}
    const menu = document.querySelector("[role=menu]");
    const row = menu && [...menu.querySelectorAll("button")][0];
    if (!row) return "no-row";
    press(row);
    return (row.textContent || "").trim();
  `);
  await sleep(2200);
  report.afterJump = JSON.parse(await header());

  // Put everything back.
  if (report.activeBefore !== null) await activate(report.activeBefore);
  await sleep(600);
  report.closeProbe = await pageEval(`
    const tab = [...document.querySelectorAll("[role=tab]")].find((n) => n.getAttribute("data-tab-id") === ${JSON.stringify(String(probeTabId))});
    const close = tab?.querySelector("[data-no-drag][role=button]");
    if (!close) return "no-close-control";
    close.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" }));
    close.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, buttons: 0, isPrimary: true, pointerId: 1, pointerType: "mouse" }));
    close.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    return tab.textContent.trim();
  `);
  await sleep(1500);
  report.headerAfter = JSON.parse(await header());
  report.ok = true;
} catch (error) {
  report.error = String(error?.message ?? error);
}
console.log(JSON.stringify(report, null, 1));
socket.close();