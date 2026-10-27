// Does a tab say "this started waiting while you were elsewhere"?
//
// The latch is the one thing the live phase cannot express: a session that is blocked
// is blocked whether or not the user is looking at it, while "you have not seen this
// yet" is only true until they look. So this opens a terminal of its own, makes it
// work, switches to another tab, and only then lets it start waiting: the tab must
// carry the unseen bar, and switching back must clear the bar without changing the
// state dot.
//
// The user's tab is activated for the middle of this and put back at the end, and the
// probe's own tab is closed, so the strip is left as it was found.
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

const MODULES = `
  const urls = performance.getEntriesByType("resource").map((e) => e.name);
  const find = (p) => { const hits = urls.filter((n) => n.includes("/src/" + p)); return hits.find((n) => n.includes("?t=")) ?? hits[0] ?? ("/src/" + p); };
  const api = await import(find("modules/terminal/lib/terminalSessionApi.ts"));
  const sessions = await import(find("modules/terminal/ghostty/useGhosttyTerminalSession.ts"));
  const activity = await import(find("modules/terminal/lib/agentActivity.ts"));
`;

/** The strip as the user sees it: each chip's dot, its unseen bar and its title. */
const strip = () =>
  pageEval(`
    const currency = document.querySelector("[data-agent-counts]");
    return JSON.stringify({
      tabs: [...document.querySelectorAll("[role=tab]")].map((tab) => ({
        id: tab.getAttribute("data-tab-id"),
        title: (tab.textContent || "").trim(),
        active: tab.getAttribute("data-tab-active") === "true",
        dot: tab.querySelector("[data-agent-state]")?.getAttribute("data-agent-state") ?? null,
        unseenBar: (() => {
          const bar = tab.querySelector("[data-agent-unseen]");
          if (!bar) return null;
          // The bar's colour is part of what the strip promises: it marks the same thing the
          // asking dot marks, so it carries that dot's own blue rather than a colour of its own.
          return {
            width: bar.getBoundingClientRect().width,
            colour: getComputedStyle(bar).backgroundColor
          };
        })()
      })),
      badge: currency ? (currency.textContent || "").trim() : null
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
const SCREEN_WORKING =
  'clear ; echo "⠹ Thinking" ; echo "ctrl+p commands   · Tokens 12.4k"';
const SCREEN_BLOCKED =
  'clear ; echo "△ Permission required" ; echo "  Allow once" ; echo "ctrl+p commands"';

try {
  await send("Page.bringToFront");
  await sleep(600);
  const before = JSON.parse(await strip());
  report.stripBefore = before;
  const activeBefore = before.tabs.find((tab) => tab.active)?.id ?? null;
  report.activeBefore = activeBefore;

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
  report.probeTabId = (JSON.parse(await strip()).tabs.find((tab) => tab.active) ?? {}).id ?? null;
  const probeTabId = report.probeTabId;

  const runCommand = (command) =>
    pageEval(`
      ${MODULES}
      return api.writeToSession(${leaf}, ${JSON.stringify(`${command}\r`)});
    `);

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

  // 1. Working on its own tab: a state, no latch (the user is looking at it).
  await runCommand(SCREEN_WORKING);
  await sleep(2200);
  report.workingOnOwnTab = JSON.parse(await strip());

  // 2. Go somewhere else, then let it start waiting. This is the latch's whole case.
  report.activateOther = await activate(activeBefore);
  await sleep(1200);
  await runCommand(SCREEN_BLOCKED);
  await sleep(2500);
  report.waitingWhileAway = JSON.parse(await strip());

  // 3. Come back: the bar goes, the dot does not.
  report.activateProbe = await activate(probeTabId);
  await sleep(2200);
  report.backOnProbeTab = JSON.parse(await strip());

  // 4. Leave again while it is still waiting: the latch is not re-armed, because it
  //    has been seen, and the dot still says the session needs an answer.
  report.activateOtherAgain = await activate(activeBefore);
  await sleep(1800);
  report.awayAgainStillWaiting = JSON.parse(await strip());

  // Put everything back.
  if (activeBefore !== null) await activate(activeBefore);
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
  report.stripAfter = JSON.parse(await strip());
  report.ok = true;
} catch (error) {
  report.error = String(error?.message ?? error);
}
console.log(JSON.stringify(report, null, 1));
socket.close();