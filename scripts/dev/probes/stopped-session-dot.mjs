// A session that has stopped must stop asking for attention.
//
// Reported by the user: a session whose agent had quit kept drawing its tab blue (`attention`) for
// the rest of the window's life. The screen is the only thing the judge used to read, and a screen
// outlives its process: quitting an agent leaves its question panel where it was and the shell's
// prompt is drawn under it, so the footer the rules read is still there - while the signal that
// would clear it never comes. The answer is a second fact from the pty itself: is any command on
// the tty, and can this machine see one at all (`pty_foreground_facts`).
//
// The second fact is the shell's own: the app's shell integration prints the OSC 133 markers, and
// the terminal's parser turns them into "a command is in flight" / "a prompt has been drawn since".
// This probe reports that beside the colour, because the two can disagree and which one is wrong is
// a different bug depending on which. (The system's process table was tried first and is wrong on
// this platform: a command started in Git bash is recorded against a fork helper that exits at once,
// so the parent table says the shell has no children while `sleep 60` runs.)
//
// Three claims, measured from the DOM the tab strip draws and from the activity store:
//
//   1. held:     a panel with a process behind it (`sleep`) stays `attention` for as long as the
//                process is there. This is the state a real question is in, and no fix may touch it.
//   2. stopped:  the same panel with nothing behind it - the command printed it and exited - leaves
//                `attention` within the settle window and never returns to it. This is the reported
//                case. Whether it lands on a green dot or on no dot at all depends on whether the
//                first screen read beat the shell's exit marker, and both say "nothing is asking
//                you anything"; what must never happen is the blue staying.
//   3. again:    a command written into that same session afterwards earns `attention` again, so
//                "nothing running" cannot silence a session for good.
//
// The fixture is a temporary agent tab opened through the app's own `newAgentTab` (its DEV hook),
// nothing is typed into the user's own terminals, and the tab is closed at the end.
//
// Usage:
//   pnpm tauri dev
//   node scripts/dev/probes/stopped-session-dot.mjs [--port=9222] [--settle=6000]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
/** How long after the write a stopped session may still be `attention`, in ms. */
const settleMs = Number(
  process.argv.find((a) => a.startsWith("--settle="))?.slice(9) ?? "6000",
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = {};
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) fail("dev 构建的窗口没找到（pnpm tauri dev 起了吗）");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => socket.addEventListener("open", () => r()));
let id = 1;
const pending = new Map();
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
  const activity = await import(find("modules/terminal/lib/agentActivity.ts"));
`;

/** What the chip for one tab draws, plus the store's own record for its pty. */
const readTab = (tabId, leafId) =>
  pageEval(`
    ${MODULES}
    const dot = document.querySelector('[data-tab-id="' + ${tabId} + '"] [data-agent-state]');
    const state = activity.useAgentActivityStore.getState();
    const pty = state.leafPty[${leafId}];
    return JSON.stringify({
      dot: dot ? { state: dot.getAttribute("data-agent-state"), colour: dot.getAttribute("data-agent-colour") } : null,
      phase: pty === undefined ? null : (state.phases[pty] ?? null),
      agent: pty === undefined ? null : (state.agents[pty] ?? null),
      // What the shell said: true = a command of its own is in flight, null = it never said, and
      // "unsupported" on a build that predates the judge reading it (the "before" run).
      commandRunning: typeof api.leafCommandRunning === "function" ? api.leafCommandRunning(${leafId}) : "unsupported",
      tail: (api.leafScreenTail(${leafId}) ?? "").trim().split("\\n").slice(-4),
    });
  `).then((raw) => JSON.parse(raw));

/** One agent tab of the probe's own, and the leaf it is showing. */
const openAgentTab = async (label) => {
  const before = JSON.parse(
    await pageEval(`
      ${MODULES}
      return JSON.stringify(window.__vertaNewAgentTab ? "ready" : "no-hook");
    `),
  );
  if (before === "no-hook") fail("没有 __vertaNewAgentTab（dev 构建才有）");
  const opened = JSON.parse(
    await pageEval(`
      const open = window.__vertaNewAgentTab;
      return JSON.stringify(open(undefined, ${JSON.stringify(`probe-${label}`)}, "opencode"));
    `),
  );
  if (opened.error) fail(opened.error);
  let tail = "";
  for (let attempt = 0; attempt < 40 && tail.trim().length === 0; attempt += 1) {
    await sleep(500);
    tail = await pageEval(`
      ${MODULES}
      return api.leafScreenTail(${opened.leafId}) ?? "";
    `);
  }
  if (tail.trim().length === 0) fail(`${label}: shell 没起来`);
  report[label] = { tabId: opened.tabId, leafId: opened.leafId };
  return opened;
};

const write = (leafId, command) =>
  pageEval(`
    ${MODULES}
    return api.writeToSession(${leafId}, ${JSON.stringify(`${command}\r`)});
  `);

/** The opencode question panel's own footer, which is what identifies it (`agentRules.ts`). */
const PANEL = "↑↓ select  enter submit  esc dismiss";

const sample = async (label, tabId, leafId, ms, every = 500) => {
  const samples = [];
  for (let t = 0; t <= ms; t += every) {
    if (t > 0) await sleep(every);
    samples.push({ t, ...(await readTab(tabId, leafId)) });
  }
  report[label] = samples;
  return samples;
};

const states = (samples) => samples.map((s) => s.dot?.state ?? "none");

try {
  await send("Page.bringToFront");
  await sleep(600);

  // Case 1: a panel with a process behind it. This is what a real question looks like, and the only
  // thing that may ever read as `attention`.
  const held = await openAgentTab("held");
  await write(held.leafId, `clear ; printf '${PANEL}\\n' ; sleep 30`);
  const heldSamples = await sample("heldSamples", held.tabId, held.leafId, 8000);
  const heldStates = states(heldSamples);
  // The first read can land before the panel is painted; from a second in, every read must say
  // attention while `sleep` owns the tty.
  const heldAfterOne = heldStates.slice(2);
  if (!heldAfterOne.every((s) => s === "attention")) {
    fail(
      `前台有命令时不该降级，实际读到 ${JSON.stringify(heldStates)}，命令在跑=${JSON.stringify(
        heldSamples.map((s) => s.commandRunning),
      )}`,
    );
  }
  if (
    heldSamples.some((s) => s.commandRunning === true) &&
    !heldSamples.slice(2).every((s) => s.commandRunning === true)
  ) {
    fail(
      `shell 没说有命令在跑：${JSON.stringify(heldSamples.map((s) => s.commandRunning))}`,
    );
  }
  report.heldVerdict = "attention 全程保持";

  // Case 2: the same panel, printed by a command that has exited. Nothing is on the tty, so the
  // panel is the last frame a dead process painted - and the reported bug is that the tab stayed
  // blue over it for the rest of the window's life.
  const stopped = await openAgentTab("stopped");
  await write(stopped.leafId, `clear ; printf '${PANEL}\\n'`);
  const stoppedSamples = await sample(
    "stoppedSamples",
    stopped.tabId,
    stopped.leafId,
    settleMs + 6000,
  );
  const stoppedStates = states(stoppedSamples);
  report.stoppedSeen = [...new Set(stoppedStates)];
  const settledFrom = stoppedSamples.filter((s) => s.t >= settleMs);
  const stillBlue = settledFrom.filter((s) => s.dot?.state === "attention");
  if (stillBlue.length > 0) {
    fail(
      `已停止的会话仍在要注意力：t=${stillBlue[0].t}ms 仍是 attention，${JSON.stringify(stoppedStates)}，命令在跑=${JSON.stringify(
        stoppedSamples.map((s) => s.commandRunning),
      )}`,
    );
  }
  if (
    settledFrom.some((s) => s.commandRunning === false) &&
    !settledFrom.every((s) => s.commandRunning === false)
  ) {
    fail(
      `命令退出后 shell 没说已回到提示符：${JSON.stringify(stoppedSamples.map((s) => s.commandRunning))}`,
    );
  }
  report.stoppedVerdict = `attention 已撤销（${[...new Set(states(settledFrom))].join("/")}）`;

  // Case 3: a command in that same session earns attention again. Without this, "nothing running"
  // could be a latch: the session would be silent for the rest of its life.
  await write(stopped.leafId, `clear ; printf '${PANEL}\\n' ; sleep 12`);
  const again = await sample("againSamples", stopped.tabId, stopped.leafId, 6000);
  const againStates = states(again);
  if (!againStates.slice(4).every((s) => s === "attention")) {
    fail(`新命令起来后没有重新变蓝：${JSON.stringify(againStates)}`);
  }
  report.againVerdict = "新命令起来后重新 attention";

  report.ok = true;
} catch (error) {
  report.error = String(error?.message ?? error);
}

// The probe's own tabs go away, whatever happened above: a fixture left in the user's strip is a
// bug of its own, and the release build cannot open one of these itself.
for (const label of ["held", "stopped"]) {
  const tab = report[label];
  if (!tab) continue;
  try {
    await pageEval(`
      const el = document.querySelector('[data-tab-id="${tab.tabId}"]');
      const close = el?.querySelector("[data-no-drag][role=button]");
      if (!close) return "no-close-control";
      close.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" }));
      close.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, buttons: 0, isPrimary: true, pointerId: 1, pointerType: "mouse" }));
      close.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, buttons: 0 }));
      return "closed";
    `);
  } catch (error) {
    report[`${label}Close`] = String(error?.message ?? error);
  }
}
await sleep(1500);
report.stripAfter = await pageEval(`
  return JSON.stringify([...document.querySelectorAll("[role=tab]")].map((tab) => ({
    id: tab.getAttribute("data-tab-id"),
    text: (tab.textContent || "").trim(),
    dot: tab.querySelector("[data-agent-state]")?.getAttribute("data-agent-state") ?? null,
  })));
`);

// The report is the evidence: states, the fact the judge was given, and the last rows of the screen
// it was reading. The samples are printed whole so a failure shows when it happened.
console.log(JSON.stringify(report, null, 1));
socket.close();
if (report.ok !== true) process.exit(1);
