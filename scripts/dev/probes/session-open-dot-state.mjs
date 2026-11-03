// Open one session from the list and record what its state dot is drawn from, tick by tick.
//
// The complaint: a session with no chat today opens with an orange dot. Orange is `working` (or
// `background`) - a question is blue - so the question is which rule reads the opened session's
// screen as work, and on what text. This walks the judge's own path (`identifyAgent` -> `evaluate`
// -> the winning rule's id) beside the store's phase, so the answer is a rule name and the screen it
// matched rather than a description of a colour.
//
// The store is *subscribed* to rather than polled for phase changes: `applySignal` sets a phase
// through zustand's internal setter, so wrapping `setState` sees nothing, and the rule that fired is
// only identifiable in the screen that was up at that instant. The subscription reads the live
// screens the moment a phase moves and records the verdict with it.
//
// Usage: node scripts/dev/probes/session-open-dot-state.mjs [--title=daily task] [--tool=pi] [--seconds=30]
import { mkdtempSync } from "node:fs";

const title = process.argv.find((a) => a.startsWith("--title="))?.slice(8) ?? "daily task";
const tool = process.argv.find((a) => a.startsWith("--tool="))?.slice(7) ?? null;
const seconds = Number(process.argv.find((a) => a.startsWith("--seconds="))?.slice(10) ?? "30");
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const keep = process.argv.includes("--keep");

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(
      r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text,
    );
  }
  return r.result?.result?.value;
};
const finder = `const urls = performance.getEntriesByType("resource").map((e) => e.name);
const find = (p) => { const h = urls.filter((n) => n.includes(p)); return h.filter((n) => n.includes("?t=")).pop() ?? h.pop(); };`;

/** The session list has to be on screen for a row to be clickable. */
const clickedSidebar = await ev(`(() => {
  const rows = () => [...document.querySelectorAll("[data-session-id]")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).length;
  if (rows() > 0) return "already";
  const tab = [...document.querySelectorAll("button")].find((b) => /^(会话|Sessions)$/.test((b.getAttribute("aria-label") || "").trim()));
  if (!tab) return "no sessions tab";
  tab.click();
  return "clicked";
})()`);
if (clickedSidebar === "clicked") await sleep(1500);
console.log(`session list: ${clickedSidebar}`);

/** Installs the in-page recorder once, so the page keeps accumulating across pauses here. */
await ev(`(async () => { ${finder}
  if (window.__dotProbe?.installed) return "already";
  const activity = await import(find("/src/modules/terminal/lib/agentActivity.ts"));
  const rules = await import(find("/src/modules/terminal/lib/agentRules.ts"));
  const agentState = await import(find("/src/modules/terminal/lib/agentState.ts"));
  const api = await import(find("/src/modules/terminal/lib/terminalSessionApi.ts"));
  const ghostty = await import(find("/src/modules/terminal/ghostty/useGhosttyTerminalSession.ts"));
  const probe = { installed: true, log: [], startedAt: Date.now(), commands: {}, ticks: 0 };
  window.__dotProbe = probe;

  // The command each leaf was handed, so the recorder can say what the tab was opened with.
  probe.note = (leaf, command) => { probe.commands[leaf] = command; };

  const readLeaves = () => (ghostty.ghosttySessionDiagnostics?.() ?? []).map((d) => d.leafId);
  const verdicts = () => {
    const state = activity.useAgentActivityStore.getState();
    return readLeaves().flatMap((leaf) => {
      const tail = api.leafScreenTail(leaf);
      if (tail === null) return [];
      const family = rules.identifyAgent(tail);
      const verdict = family ? agentState.evaluate(tail, family.rules) : null;
      const ptyId = state.leafPty[leaf];
      return [{
        leaf,
        pty: ptyId ?? null,
        phase: ptyId === undefined ? null : state.phases[ptyId] ?? null,
        agent: family?.tool ?? null,
        rule: verdict?.rule ?? null,
        judged: verdict?.state ?? null,
        tail: tail.slice(-220),
        at: Date.now() - probe.startedAt,
      }];
    });
  };
  probe.snapshot = () => {
    const state = activity.useAgentActivityStore.getState();
    return {
      leaves: verdicts(),
      phases: { ...state.phases },
      agents: { ...state.agents },
      unseen: { ...state.unseen },
      unseenDone: { ...state.unseenDone },
      foreground: [...state.foregroundLeaves],
      dots: [...document.querySelectorAll("[data-agent-state]")].map((el) => ({
        state: el.getAttribute("data-agent-state"),
        colour: el.getAttribute("data-agent-colour"),
        on: (el.closest("[data-tab-id]")?.innerText || "").trim().slice(0, 18) || "(not a tab)",
      })),
      commands: { ...probe.commands },
    };
  };

  let previous = activity.useAgentActivityStore.getState().phases;
  activity.useAgentActivityStore.subscribe((state) => {
    const now = state.phases;
    const stamps = [];
    for (const key of new Set([...Object.keys(previous), ...Object.keys(now)])) {
      if (previous[key] !== now[key]) {
        stamps.push({ pty: Number(key), from: previous[key] ?? null, to: now[key] ?? null });
      }
    }
    previous = now;
    if (stamps.length === 0) return;
    probe.log.push({ at: Date.now() - probe.startedAt, stamps, leaves: verdicts() });
  });
  return "installed";
})()`);

// Which session row to click: by title, and by the tool its record says, because two sessions can
// share a title and the one that was reported is a specific tool's.
const picked = await ev(`(async () => { ${finder}
  const launcher = await import(find("/src/modules/launcher/index.ts"));
  const loaded = await launcher.loadAllAgentSessions();
  const all = loaded.sessions ?? [];
  const byId = new Map(all.map((s) => [s.id, s]));
  const rows = [...document.querySelectorAll("[data-session-id]")].filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    if (!(el.textContent || "").includes(${JSON.stringify(title)})) return false;
    return ${tool ? `byId.get(el.getAttribute("data-session-id"))?.tool === ${JSON.stringify(tool)}` : "true"};
  });
  if (rows.length === 0) {
    return { ok: false, why: "no visible row", candidates: all.filter((s) => s.title.includes(${JSON.stringify(title)})).map((s) => ({ id: s.id, tool: s.tool, distro: s.distro ?? null, cwd: s.cwd })) };
  }
  const row = rows[0];
  const session = byId.get(row.getAttribute("data-session-id"));
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    row.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  }
  row.click();
  return { ok: true, id: session.id, tool: session.tool, distro: session.distro ?? null, cwd: session.cwd, title: session.title };
})()`);
if (!picked.ok) {
  console.log(JSON.stringify(picked, null, 2));
  process.exit(1);
}
console.log(
  `opened ${picked.title} (${picked.id}, tool ${picked.tool}, cwd ${picked.cwd}) at t=0`,
);

for (let i = 0; i < (seconds * 1000) / 1000; i++) {
  await sleep(1000);
  const snap = JSON.parse(await ev(`JSON.stringify(window.__dotProbe.snapshot())`));
  const mine = snap.leaves.find((leaf) => leaf.pty !== null && leaf.agent === picked.tool);
  const logged = await ev(`JSON.stringify(window.__dotProbe.log.slice(${i === 0 ? 0 : -1}))`);
  console.log(
    `+${i + 1}s ${mine ? `leaf ${mine.leaf} pty ${mine.pty} phase=${mine.phase ?? "none"} judged=${mine.judged ?? "-"} rule=${mine.rule ?? "-"}` : "(no leaf for this tool yet)"}`,
  );
  if (mine && (mine.phase === "working" || mine.judged === "working")) {
    console.log(`      screen: ${JSON.stringify(mine.tail)}`);
  }
}

const final = JSON.parse(await ev(`JSON.stringify(window.__dotProbe.snapshot())`));
console.log(`\nphase log (every move, with the screen verdict at that moment):`);
const log = JSON.parse(await ev(`JSON.stringify(window.__dotProbe.log)`));
for (const entry of log) {
  const where = entry.leaves.map((l) => `leaf ${l.leaf}/pty ${l.pty} judged=${l.judged ?? "-"} rule=${l.rule ?? "-"}`).join("; ");
  console.log(`  +${(entry.at / 1000).toFixed(1)}s ${JSON.stringify(entry.stamps)}  |  ${where}`);
}
console.log(`\ndots now: ${JSON.stringify(final.dots)}`);
console.log(`phases now: ${JSON.stringify(final.phases)}`);
console.log(`unseen: ${JSON.stringify(Object.keys(final.unseen))}  unseenDone: ${JSON.stringify(Object.keys(final.unseenDone))}  foreground: ${JSON.stringify(final.foreground)}`);
socket.close();
