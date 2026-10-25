// Does the front-end agent judge read a screen and drive the activity store?
//
// The judge is a plain function over text, so its unit tests prove the decision.
// What they cannot prove is that a live screen ever reaches it: the reader has to
// walk the terminal model's rows, the identify step has to fire on real chrome, and
// the store has to end up with what the tab dots will be drawn from. This runs that
// whole path on the running app.
//
// The screens are printed with `echo` rather than by launching an agent: the claim
// under test is "the judge reads the screen", and printing the screen is the
// cheapest honest way to produce one. The text below is the footer, spinner and
// card the rules were written from. The terminal is a plain tab of this probe's own
// (not a blocks tab, whose output the block overlay owns) and it is closed again at
// the end, so nothing of the user's is typed into or left behind.
//
// Bring the window forward first: a pane that is not presented never starts its
// session, and an occluded window has its terminal output coalesced, so the screen
// under test would not be the screen on display.
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

// A dynamic import of a module's bare dev path gets a *fresh* module instance once
// the dev server has hot-updated it (the window holds it at `?t=<stamp>`), which
// would mean reading a store the window is not using. The URLs come from the
// resource timing log instead, stamped one first, so whatever is read here is the
// instance the window is running.
const MODULES = `
  const urls = performance.getEntriesByType("resource").map((e) => e.name);
  const find = (path) => {
    const hits = urls.filter((n) => n.includes("/src/" + path));
    return hits.find((n) => n.includes("?t=")) ?? hits[0] ?? ("/src/" + path);
  };
  const api = await import(find("modules/terminal/lib/terminalSessionApi.ts"));
  const sessions = await import(find("modules/terminal/ghostty/useGhosttyTerminalSession.ts"));
  const activity = await import(find("modules/terminal/lib/agentActivity.ts"));
`;

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

const snapshot = async () =>
  JSON.parse(
    await pageEval(`
      ${MODULES}
      const state = activity.useAgentActivityStore.getState();
      return JSON.stringify({
        leaves: sessions.ghosttySessionDiagnostics().map((d) => ({ leafId: d.leafId, pty: d.pty, visible: d.visible })),
        phases: state.phases,
        agents: state.agents,
      });
    `),
  );

const tailLines = async (leafId) =>
  (
    await pageEval(`
      ${MODULES}
      return api.leafScreenTail(${leafId}) ?? "(null)";
    `)
  )
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-4);

const runCommand = (leafId, command) =>
  pageEval(`
    ${MODULES}
    return api.writeToSession(${leafId}, ${JSON.stringify(`${command}\r`)});
  `);

// The screens, exactly as the rules were written from.
const SCREEN_IDLE = [
  'echo "Where to next?"',
  'echo "ctrl+p commands   · Tokens 12.4k"',
].join(" ; ");
const SCREEN_WORKING = [
  'echo "⠹ Thinking"',
  'echo "ctrl+p commands   · Tokens 12.4k"',
].join(" ; ");
const SCREEN_BLOCKED = [
  'echo "△ Permission required"',
  'echo "  Allow once"',
  'echo "ctrl+p commands"',
].join(" ; ");

const report = {};
try {
  await send("Page.bringToFront");
  await sleep(600);
  const before = await snapshot();
  report.tabsBefore = await pageEval(
    `return JSON.stringify([...document.querySelectorAll("[role=tab]")].map((n) => (n.textContent || "").trim()))`,
  );

  // A terminal of this probe's own, opened through the product's own shortcut. The
  // menu's "终端" item is a submenu, and reaching into it with synthetic pointer
  // events is far less reliable than the key the same command is bound to.
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

  const known = new Set(before.leaves.map((leaf) => leaf.leafId));
  let target = null;
  for (let attempt = 0; attempt < 40 && !target; attempt += 1) {
    await sleep(500);
    const now = await snapshot();
    target = now.leaves.find((leaf) => !known.has(leaf.leafId)) ?? null;
  }
  if (!target) {
    // The key did not take: fall back to the plus menu and its submenu.
    report.menu = await pageEval(`
      ${PRESS}
      const button = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("title") || "").includes("标签页"));
      if (!button) return "no-new-tab-button";
      press(button);
      return "pressed";
    `);
    await sleep(700);
    report.submenu = await pageEval(`
      ${PRESS}
      const trigger = [...document.querySelectorAll("[role=menuitem]")].find((n) => (n.textContent || "").trim().startsWith("终端"));
      if (!trigger) return "no-submenu-trigger";
      trigger.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
      trigger.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerType: "mouse" }));
      return "moved";
    `);
    await sleep(700);
    report.menuItem = await pageEval(`
      ${PRESS}
      const item = [...document.querySelectorAll("[role=menuitem]")].find((n) => (n.textContent || "").trim() === "默认终端");
      if (!item) return "no-default-terminal-item";
      press(item);
      return "pressed";
    `);
    for (let attempt = 0; attempt < 30 && !target; attempt += 1) {
      await sleep(500);
      const now = await snapshot();
      target = now.leaves.find((leaf) => !known.has(leaf.leafId)) ?? null;
    }
  }
  if (!target) throw new Error("新会话没起来");
  report.leaf = target;
  await sleep(2500);

  const pty = await pageEval(`
    ${MODULES}
    return api.ptyIdForLeaf(${target.leafId});
  `);
  report.pty = pty;

  // Wait for the shell to be up: a write that arrives before the pty has a shell
  // reading it is lost, and the first screen of the test would then be a blank one.
  let ready = false;
  for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
    await sleep(500);
    ready = (await tailLines(target.leafId)).length > 0;
    report.readyAfterMs = (attempt + 1) * 500;
  }
  if (!ready) throw new Error("shell 没起来");

  const read = async () => {
    const snap = await snapshot();
    return {
      phase: snap.phases[pty] ?? null,
      agent: snap.agents[pty] ?? null,
      tail: await tailLines(target.leafId),
    };
  };

  report.initial = await read();

  // Every screen clears first, the way an agent's interface repaints: printing on
  // top of the previous screen would leave the earlier card in the bottom lines the
  // rules read, which is a property of the test, not of an agent.
  const step = async (label, screen, waitMs = 2000) => {
    await runCommand(target.leafId, `clear ; ${screen}`);
    await sleep(waitMs);
    report[label] = await read();
  };

  // Idle: the agent's own footer, with nothing moving on it.
  await step("idle", SCREEN_IDLE);
  // Working: a spinner frame and the status word.
  await step("working", SCREEN_WORKING);
  // Blocked: the permission card.
  await step("blocked", SCREEN_BLOCKED);
  // The user answers and the turn ends: the state leaves blocked and the store
  // shows it as done for a few seconds before settling on idle.
  await step("finished", SCREEN_IDLE, 1000);
  await sleep(7000);
  report.settled = await read();

  // The agent leaves the screen while the shell goes on, which is the case a state
  // has to be able to leave "working" through. Clearing the screen leaves nothing of
  // the agent on it; the judge needs its grace period (the screen has to stop
  // identifying an agent for a while before that counts as gone), so this wait is
  // longer than the others.
  await step("workingAgain", SCREEN_WORKING);
  await step("cleared", "", 3500);

  // Put the tab back: close the one this probe opened.
  report.closeTarget = await pageEval(`
    ${PRESS}
    const tabs = [...document.querySelectorAll("[role=tab]")];
    const tab = tabs[tabs.length - 1];
    const close = tab?.querySelector("[data-no-drag][role=button]");
    if (!close) return "no-close-control";
    press(close);
    return tab.textContent.trim();
  `);
  await sleep(1500);
  report.tabsAfter = await pageEval(
    `return JSON.stringify([...document.querySelectorAll("[role=tab]")].map((n) => (n.textContent || "").trim()))`,
  );
  report.ok = true;
} catch (error) {
  report.error = String(error?.message ?? error);
}
console.log(JSON.stringify(report, null, 1));
socket.close();