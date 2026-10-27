// Record what happens to the state dots while the window is being used.
//
// Reported from the running app: the breathing dot is gone once you switch to another file,
// session or terminal, and a session that is still working goes green. That can be four
// different things and none of them is visible in a single reading of the strip: the detector
// may report the agent gone (`exited` clears the entry outright), the phase may decay on its own
// (a `finished` signal is held for six seconds and then becomes `idle`), the chip may stop
// drawing a dot, or the dot may be drawn and not painting. So this records the whole sequence
// rather than one frame:
//
//   * every detector signal the app receives, with the millisecond it arrived,
//   * every change to the store's phases, agents and latch,
//   * every change to each tab's own dot, as its computed colour, opacity and animation state,
//   * and every time the judge's verdict changes on a screen, with the rule that won and the rows
//     it read - a dot that flips back and forth is only explicable by the screen that flipped it.
//
// Nothing is opened, switched or closed: it watches whatever the user does, which is the only way
// to catch a report about switching, and it can run while the switch happens.
//
// Entries are streamed out one at a time rather than collected into one long evaluation: a watch
// of a few minutes held open that way gets aborted by the debugger, and the run is lost. Each
// entry arrives as a console line, so what has been seen is already outside the page.
//
// Usage: node scripts/dev/probes/state-dot-watch.mjs --seconds=45
const seconds = Number(
  process.argv.find((a) => a.startsWith("--seconds="))?.slice(10) ?? "45",
);

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) {
  console.error("dev 起来了？没找到主窗口的 page 目标。");
  process.exit(1);
}
const socket = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
const pending = new Map();
const collected = [];
const PREFIX = "VERTA-DOT-WATCH ";
await new Promise((r) => socket.addEventListener("open", () => r()));
socket.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.consoleAPICalled") {
    for (const arg of m.params.args ?? []) {
      if (typeof arg.value === "string" && arg.value.startsWith(PREFIX)) {
        collected.push(JSON.parse(arg.value.slice(PREFIX.length)));
      }
    }
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
await send("Runtime.enable");
const pageEval = async (body) => {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => {\n${body}\n})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.error) throw new Error(`${r.error.message}: ${r.error.data ?? ""}`);
  if (r.result?.exceptionDetails) {
    throw new Error(
      r.result.exceptionDetails.exception?.description ??
        r.result.exceptionDetails.text,
    );
  }
  return r.result?.result?.value;
};

// The recording happens inside the page: signals arrive on the app's own channel and the store
// is read there, so nothing has to cross the debugger while it runs.
await pageEval(`
  const urls = performance.getEntriesByType("resource").map((e) => e.name);
  const find = (p) => { const hits = urls.filter((n) => n.includes("/src/" + p)); return hits.find((n) => n.includes("?t=")) ?? hits[0] ?? ("/src/" + p); };
  const activity = await import(find("modules/terminal/lib/agentActivity.ts"));
  const api = await import(find("modules/terminal/lib/terminalSessionApi.ts"));
  const sessions = await import(find("modules/terminal/ghostty/useGhosttyTerminalSession.ts"));
  const rules = await import(find("modules/terminal/lib/agentRules.ts"));
  const judging = await import(find("modules/terminal/lib/agentState.ts"));

  window.__vertaDotWatch?.stop?.();
  const prefix = ${JSON.stringify(PREFIX)};
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const emit = (entry) => console.log(prefix + JSON.stringify(entry));

  const dotOf = (el) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      state: el.getAttribute("data-agent-state"),
      colour: s.backgroundColor,
      opacity: Number(s.opacity).toFixed(2),
      play: s.animationPlayState,
      animation: s.animationName,
      box: [Math.round(r.width), Math.round(r.height)]
    };
  };
  const snap = () => {
    const st = activity.useAgentActivityStore.getState();
    return JSON.stringify({
      phases: { ...st.phases },
      agents: { ...st.agents },
      unseen: Object.keys(st.unseen),
      inactive: document.documentElement.hasAttribute("data-window-inactive"),
      tabs: [...document.querySelectorAll("[role=tab][data-tab-id]")].map((tab) => {
        const d = dotOf(tab.querySelector("[data-agent-state]"));
        return tab.getAttribute("data-tab-id") + (tab.getAttribute("data-tab-active") === "true" ? "*" : "") + ":" + (d ? d.state + "/" + d.opacity + "/" + d.play : "-");
      }),
      // The same component draws the launch list's rows, so "the dot" can be a different
      // surface than the tab strip: a row's dot going away is recorded here too.
      rows: [...document.querySelectorAll("[data-agent-state]")]
        .filter((el) => el.closest("[role=tab]") === null)
        .map((el) => { const d = dotOf(el); return d.state + "/" + d.opacity; })
    });
  };

  // What the judge itself is deciding, and the screen it decided it on. A verdict that flips
  // back and forth is only explicable by the screen that flipped it, so the rule that won and
  // the rows it read are recorded next to the change.
  const verdicts = new Map();
  const traceTick = () => {
    for (const session of sessions.ghosttySessionDiagnostics()) {
      const tail = api.leafScreenTail(session.leafId);
      if (tail === null || tail.trim() === "") continue;
      const family = rules.identifyAgent(tail);
      if (!family) continue;
      const detection = judging.evaluate(tail, family.rules);
      const signature = family.tool + "|" + detection.state + "|" + detection.rule;
      if (verdicts.get(session.leafId) === signature) continue;
      verdicts.set(session.leafId, signature);
      emit({
        kind: "verdict",
        at: at(),
        leaf: session.leafId,
        pty: session.pty,
        tool: family.tool,
        state: detection.state,
        rule: detection.rule,
        skipped: detection.skipStateUpdate,
        // Only the rows a rule can see, so the screen is read the way the rules read it.
        rows: tail.split("\\n").filter((line) => line.trim().length > 0).slice(-12)
      });
    }
  };
  traceTick();

  let last = await snap();
  emit({ kind: "state", at: at(), first: JSON.parse(last) });
  const unsubscribe = activity.subscribeAgentSignals((payload) => {
    emit({ kind: "signal", at: at(), signal: payload });
  });
  const timer = setInterval(() => {
    traceTick();
    const now = snap();
    if (now !== last) {
      last = now;
      emit({ kind: "state", at: at(), ...JSON.parse(now) });
    }
  }, 300);
  window.__vertaDotWatch = {
    stop: () => { clearInterval(timer); unsubscribe(); }
  };
  return "started";
`);

await new Promise((r) => setTimeout(r, seconds * 1000));
// A page that reloaded mid-watch takes the recorder with it; saying so is better than printing
// a log that quietly stops.
const stopped = await pageEval(`
  if (!window.__vertaDotWatch) return "gone";
  window.__vertaDotWatch.stop();
  return "stopped";
`).catch((error) => `unreachable (${String(error).slice(0, 80)})`);

// The strip's own line is the bulk of it; the rest is printed as it stands, chronological.
const compact = [];
let previous = null;
for (const entry of collected) {
  if (entry.kind !== "state") continue;
  if (entry.first) {
    compact.push({ at: entry.at, first: entry.first });
    previous = entry.first;
    continue;
  }
  const changed = {};
  for (const key of ["inactive", "phases", "agents", "unseen"]) {
    if (JSON.stringify(previous?.[key]) !== JSON.stringify(entry[key])) {
      changed[key] = entry[key];
    }
  }
  if (JSON.stringify(previous?.tabs) !== JSON.stringify(entry.tabs)) changed.tabs = entry.tabs;
  if (JSON.stringify(previous?.rows) !== JSON.stringify(entry.rows)) changed.rows = entry.rows;
  if (Object.keys(changed).length > 0) compact.push({ at: entry.at, changed });
  previous = entry;
}

console.log(
  JSON.stringify(
    {
      seconds,
      stopped,
      entries: collected.length,
      compact,
      // The judge's own verdicts, with the rows each one was reached on. Trimmed to a readable
      // width, because a terminal row is mostly padding.
      verdicts: collected
        .filter((entry) => entry.kind === "verdict")
        .map((entry) => ({
          at: entry.at,
          leaf: entry.leaf,
          pty: entry.pty,
          tool: entry.tool,
          state: entry.state,
          rule: entry.rule,
          skipped: entry.skipped,
          rows: entry.rows.map((row) => row.replace(/\s+$/, "").slice(0, 140)),
        })),
      signals: collected.filter((entry) => entry.kind === "signal"),
    },
    null,
    1,
  ),
);
socket.close();