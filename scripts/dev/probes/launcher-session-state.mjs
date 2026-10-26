// Does the session list mark the session that is running behind a row, and lift it
// when it starts waiting?
//
// The join under test is "row -> tab -> pty -> state": a row is a *stored* session,
// the activity store is keyed by pty, and the only thing connecting them is the tab
// that resumed the session. Unit tests prove the fold and the ordering; this runs
// the whole path on the running app, from a real row click to the pixels of the list
// order.
//
// The screens are printed with `echo` (the judge's own samples, the same ones
// `agent-state-judge.mjs` uses) rather than by making a real agent ask a question,
// because "the judge reads the screen" is the claim, and printing the screen is the
// cheapest honest way to produce one. The agent is interrupted first so the shell
// owns the screen again; the tab keeps the session id it was opened with either way.
//
// It needs a session row that is not already at the top, so a move can be seen. The
// probe scrolls the list to find one, opens it, and at the end closes its tab and
// puts the user's active tab back.
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

// A dynamic import of a module's bare dev path gets a *fresh* instance once the dev
// server has hot-updated it; the URLs come from the resource timing log so whatever
// is read here is the instance the window is running.
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

/** The list as it is on screen: every row, in order, with its dot. */
const LIST = `
  ${MODULES}
  const state = activity.useAgentActivityStore.getState();
  const rows = [...document.querySelectorAll("button[data-session-id]")].map((row) => ({
    id: row.getAttribute("data-session-id"),
    state: row.querySelector("[data-agent-state]")?.getAttribute("data-agent-state") ?? null,
    title: (row.getAttribute("title") || "").split("\\n")[0],
  }));
  const tab = document.querySelector("[role=tab][data-tab-active]");
  return JSON.stringify({
    rows,
    activeTab: tab ? tab.textContent.trim() : null,
    phases: state.phases,
    leafPty: state.leafPty,
    leaves: sessions.ghosttySessionDiagnostics().map((d) => ({ leafId: d.leafId, pty: d.pty })),
  });
`;

const list = async () => JSON.parse(await pageEval(LIST));

/** Show the session list in the sidebar (rail button). */
const openLauncher = () =>
  pageEval(`
    ${PRESS}
    const rail = [...document.querySelectorAll("button")].find(
      (b) => (b.getAttribute("aria-label") || b.textContent || "").trim() === "会话",
    );
    if (!rail) return "no-rail-button";
    press(rail);
    return "pressed";
  `);

const runCommand = (leaf, command) =>
  pageEval(`
    ${MODULES}
    return api.writeToSession(${leaf}, ${JSON.stringify(`${command}\r`)});
  `);

const tailLines = async (leaf) =>
  (
    await pageEval(`
      ${MODULES}
      return api.leafScreenTail(${leaf}) ?? "(null)";
    `)
  )
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-4);

// The judge's own samples, as `agent-state-judge.mjs` prints them.
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
  report.launcher = await openLauncher();
  await sleep(2500);

  const before = await list();
  report.rowsBefore = before.rows.map((row) => row.id);
  report.statesBefore = before.rows.map((row) => row.state);
  report.activeTabBefore = before.activeTab;

  // A row that is not already first, so its move is visible. Index 2 is far enough
  // down that no session can be lifted past it by accident.
  const target = before.rows[2] ?? null;
  if (!target) throw new Error("会话列表里没有第三行");
  report.target = target;
  report.targetIndexBefore = before.rows.findIndex((row) => row.id === target.id);

  report.open = await pageEval(`
    ${PRESS}
    const row = document.querySelector('button[data-session-id="${target.id}"]');
    if (!row) return "no-row";
    press(row);
    return row.getAttribute("title") || "";
  `);
  // The tab a session opens in is labelled with the session's own title, which is how
  // the probe finds it again to close it.
  const probeTabTitle = String(report.open);
  report.probeTabTitle = probeTabTitle;

  const known = new Set(before.leaves.map((leaf) => leaf.leafId));
  let leaf = null;
  for (let attempt = 0; attempt < 60 && leaf === null; attempt += 1) {
    await sleep(500);
    const now = await list();
    leaf = now.leaves.find((l) => !known.has(l.leafId))?.leafId ?? null;
  }
  if (leaf === null) throw new Error("会话的标签没起来");
  report.leaf = leaf;
  report.activeTabAfterOpen = (await list()).activeTab;

  // Let the agent paint, then take the screen back: the tab keeps the session id it
  // was opened with, and the shell is what the judge will read.
  await sleep(8000);
  report.agentPainted = await tailLines(leaf);
  report.agentState = (await list()).rows.find((r) => r.id === target.id)?.state ?? null;

  await pageEval(`
    ${MODULES}
    return api.interruptLeaf(${leaf});
  `);
  let atPrompt = false;
  for (let attempt = 0; attempt < 20 && !atPrompt; attempt += 1) {
    await sleep(500);
    atPrompt = (await tailLines(leaf)).length > 0;
  }

  const readTarget = async () => {
    const now = await list();
    return {
      state: now.rows.find((row) => row.id === target.id)?.state ?? null,
      index: now.rows.findIndex((row) => row.id === target.id),
      order: now.rows.map((row) => row.id),
    };
  };

  // Working: the dot is there and the row stays where it was.
  await runCommand(leaf, `clear ; ${SCREEN_WORKING}`);
  await sleep(2500);
  report.working = await readTarget();
  report.workingTail = await tailLines(leaf);

  // Waiting: the dot turns amber and the row comes to the top.
  await runCommand(leaf, `clear ; ${SCREEN_BLOCKED}`);
  await sleep(2500);
  report.waiting = await readTarget();

  // Back to the user's tab, and close the one this probe opened.
  report.activateProbeTab = await pageEval(`
    ${PRESS}
    const tab = [...document.querySelectorAll("[role=tab][data-tab-id]")].find(
      (n) => (n.textContent || "").trim() === ${JSON.stringify(probeTabTitle)},
    );
    if (!tab) return "no-probe-tab";
    press(tab);
    return "active";
  `);
  await sleep(700);
  // A second read of the DOM: activating re-renders the chip, so holding the node from
  // before and clicking its child afterwards clicks something detached and does nothing.
  report.closeProbeTab = await pageEval(`
    ${PRESS}
    const tab = [...document.querySelectorAll("[role=tab][data-tab-id]")].find(
      (n) => (n.textContent || "").trim() === ${JSON.stringify(probeTabTitle)},
    );
    if (!tab) return "no-probe-tab";
    const close = tab.querySelector("[data-no-drag][role=button]");
    if (!close) return "no-close-control";
    press(close);
    return "pressed";
  `);
  await sleep(1500);
  report.restoreActive = await pageEval(`
    ${PRESS}
    const wanted = ${JSON.stringify(before.activeTab)};
    const tab = [...document.querySelectorAll("[role=tab]")].find(
      (n) => (n.textContent || "").trim() === wanted,
    );
    if (!tab) return "no-previous-tab";
    press(tab);
    return wanted;
  `);
  await sleep(1200);
  const after = await list();
  report.rowsAfter = after.rows.map((row) => row.id);
  report.statesAfter = after.rows.map((row) => row.state);
  report.activeTabAfter = after.activeTab;

  report.verdict = {
    dotAppears: report.working.state !== null,
    dotIsWorking: report.working.state === "working",
    stayedPut: report.working.index === report.targetIndexBefore,
    waitsAmber: report.waiting.state === "attention",
    lifted: report.waiting.index === 0,
    // Rows that appeared during the run (resuming a session can store it as a new
    // one) are not part of this: only the rows that were already in the list have to
    // keep their relative order.
    orderKeptElsewhere:
      report.waiting.order
        .filter((x) => x !== target.id && before.rows.some((r) => r.id === x))
        .join() ===
      before.rows
        .map((r) => r.id)
        .filter((x) => x !== target.id && report.waiting.order.indexOf(x) !== -1)
        .join(),
  };
  report.ok = true;
} catch (error) {
  report.error = String(error?.message ?? error);
}
console.log(JSON.stringify(report, null, 1));
socket.close();