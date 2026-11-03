// Open session after session and report, for each, where the cover lifted and whether the launch
// command was still on screen at that instant.
//
// The reported defect is intermittent - "偶尔还能看见那行命令" - so one successful opening proves
// nothing; this opens as many as the list offers, one at a time, and judges every one.
//
// Where the judgement comes from: the app records a DEV-only trace of its cover loop
// (`window.__vertaOpenTrace`, see `waitForAgentUi` in `src/app/App.tsx`) with one entry per tick and
// a final entry naming the rule that lifted it. That trace says when the loop *decided*, not what the
// frame showed, so the trace's own `push` is wrapped here: the instant an exit entry appears, the
// screen of every live leaf is read and tested with the app's own `screenShowsLaunchLine` against the
// command the app was about to type - the same matcher the guard itself uses. That is the exact
// question the defect asks ("was the command line visible when the cover came off"), asked of the
// screen rather than of the rule's inputs.
//
// Nothing is created or changed: it clicks rows of the session list the user already has, and closes
// the terminal of each tab it opened afterwards.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rounds = Number(process.argv.find((a) => a.startsWith("--rounds="))?.slice(9) ?? "5");
const shots = Number(process.argv.find((a) => a.startsWith("--shots="))?.slice(8) ?? "2");
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const dir = join(tmpdir(), "verta-cover-repeat");
mkdirSync(dir, { recursive: true });

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
      r.result.exceptionDetails.exception?.description ??
        r.result.exceptionDetails.text,
    );
  }
  return r.result?.result?.value;
};

/** The in-page half: pick a row, click it, and read the screen at the instant the cover lifts. */
const OPEN_ONE = (usedIds) => `(async () => {
  const urls = performance.getEntriesByType("resource").map((e) => e.name);
  const find = (p) => { const h = urls.filter((n) => n.includes(p)); return h.filter((n) => n.includes("?t=")).pop() ?? h.pop(); };
  const mods = window.__coverProbeMods ?? (window.__coverProbeMods = {});
  mods.launcher = mods.launcher ?? (await import(find("/src/modules/launcher/index.ts")));
  mods.open = mods.open ?? (await import(find("/src/modules/launcher/lib/openSession.ts")));
  mods.api = mods.api ?? (await import(find("/src/modules/terminal/lib/terminalSessionApi.ts")));
  mods.launch = mods.launch ?? (await import(find("/src/modules/terminal/lib/launchLine.ts")));
  mods.ghostty = mods.ghostty ?? (await import(find("/src/modules/terminal/ghostty/useGhosttyTerminalSession.ts")));

  const used = new Set(${JSON.stringify(usedIds)});
  const rows = [...document.querySelectorAll("[data-session-id]")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !used.has(el.getAttribute("data-session-id"));
  });
  if (rows.length === 0) return { ok: false, why: "no visible unused session row" };

  const loaded = await mods.launcher.loadAllAgentSessions();
  const all = loaded.sessions ?? [];
  const byId = new Map(all.map((s) => [s.id, s]));
  // Local sessions only: a distro resume runs inside the distribution and takes a different, much
  // longer path, which is a different question from the one this probe asks.
  const pickable = rows.filter((el) => !byId.get(el.getAttribute("data-session-id"))?.distro);
  if (pickable.length === 0) return { ok: false, why: "no visible unused local session row" };
  const row = pickable[0];
  const sessionId = row.getAttribute("data-session-id");
  const title = (row.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40);
  const session = byId.get(sessionId);
  if (!session) return { ok: false, why: "row without a session record", sessionId, title };
  const plan = mods.open.planSessionOpen(session);
  if (!plan) return { ok: false, why: "no plan for this session", sessionId, title };
  const command = plan.command;

  const liveLeaves = () =>
    (mods.ghostty.ghosttySessionDiagnostics?.() ?? [])
      .map((d) => d.leafId)
      .filter((leaf) => mods.api.leafScreenTail(leaf) !== null);
  const before = liveLeaves();
  const sample = (tag) =>
    liveLeaves().map((leaf) => {
      const tail = mods.api.leafScreenTail(leaf);
      return { tag, leaf, cwd: mods.api.leafCwd(leaf), showsLaunch: tail === null ? null : mods.launch.screenShowsLaunchLine(tail, command), tail: (tail ?? "").slice(-120) };
    });

  window.__vertaOpenTrace = [];
  const trace = window.__vertaOpenTrace;
  const atExit = [];
  let exit = null;
  let overlayVariant = undefined;
  window.__vertaOpenTrace = new Proxy(trace, {
    get(target, prop) {
      if (prop === "push") {
        return (entry) => {
          if (entry && entry.exit && !exit) {
            exit = { exit: entry.exit, t: entry.t, bytes: entry.bytes ?? null, silentFor: entry.silentFor ?? null };
            // The cover is still up at this instant (its removal happens after the wait returns),
            // so its variant can be read here. A JSON null means the settings draw no transition.
            overlayVariant = document.querySelector("[data-session-opening]")?.getAttribute("data-session-opening-variant") ?? null;
            atExit.push(...sample("at-exit"));
          }
          return target.push(entry);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const startedAt = Date.now();
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    row.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  }
  row.click();

  const afterExit = [];
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && !exit) await new Promise((r) => setTimeout(r, 20));
  // The question the defect asks is about the first frame the *user* sees, which is the one after
  // the cover goes: the terminal is hidden while the cover is up, so a screen read at the moment the
  // loop decided says nothing about what is uncovered. This waits for the cover to leave the DOM
  // and reads then.
  let atUncover = null;
  const uncoverDeadline = Date.now() + 8000;
  while (Date.now() < uncoverDeadline) {
    if (!document.querySelector("[data-session-opening]")) {
      atUncover = { ms: Date.now() - startedAt, samples: sample("at-uncover") };
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  for (const dt of [60, 200, 500]) {
    await new Promise((r) => setTimeout(r, dt));
    afterExit.push(...sample("+" + dt + "ms"));
  }
  const ticks = trace.filter((e) => e.t !== undefined && !e.exit && !e.heldBy);
  const now = liveLeaves();
  return {
    ok: true,
    sessionId,
    title,
    tool: session.tool,
    distro: session.distro ?? null,
    cwd: session.cwd,
    command,
    exit,
    exitAfterMs: exit ? exit.t : null,
    sawExit: exit !== null,
    waitedMs: Date.now() - startedAt,
    ticks: ticks.length,
    heldBy: trace.filter((e) => e.heldBy).map((e) => e.heldBy),
    hardCap: trace.some((e) => e.exit === "hard-cap"),
    leavesBefore: before,
    /** The terminal tab this opening added, so the probe can close exactly that one. */
    openedLeaf: now.find((leaf) => !before.includes(leaf)) ?? null,
    /** Which transition the settings drew, read while the cover was still up. */
    overlayVariant,
    /** What the terminal showed the instant the cover left the DOM - the first frame seen. */
    atUncover,
    atExit,
    afterExit,
    canvas: (() => {
      const c = document.querySelector("canvas");
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    })(),
  };
})()`;

const used = [];
const results = [];
let shotIndex = 0;

for (let round = 1; round <= rounds; round++) {
  // A burst of screenshots over the whole opening, so the frames around the lift can be looked at.
  let bursting = null;
  const burst = [];
  if (shotIndex < shots) {
    shotIndex++;
    bursting = (async () => {
      for (let i = 0; i < 50; i++) {
        const shot = await send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        }).catch(() => null);
        const data = shot?.result?.data;
        if (data) {
          const file = join(dir, `round${round}-${String(i).padStart(3, "0")}.png`);
          writeFileSync(file, Buffer.from(data, "base64"));
          burst.push(file);
        }
        await sleep(200);
      }
    })();
  }

  const record = await ev(OPEN_ONE(used));
  if (!record.ok) {
    console.log(`round ${round}: skipped - ${record.why} ${record.sessionId ?? ""}`);
    if (bursting) await bursting;
    if (!record.sessionId) break;
    used.push(record.sessionId);
    continue;
  }
  used.push(record.sessionId);
  results.push(record);

  const leakedAtExit = record.atExit.filter((s) => s.showsLaunch === true);
  const leakedAtUncover = (record.atUncover?.samples ?? []).filter((s) => s.showsLaunch === true);
  const leakedAfter = record.afterExit.filter((s) => s.showsLaunch === true);
  console.log(
    JSON.stringify(
      {
        round,
        session: `${record.title} (${record.tool}${record.distro ? `, ${record.distro}` : ""})`,
        command: record.command,
        coverVariant: record.overlayVariant,
        exit: record.exit,
        uncoveredAfterMs: record.atUncover?.ms ?? null,
        ticks: record.ticks,
        heldBy: record.heldBy,
        hardCap: record.hardCap,
        // The defect: the launch line visible in the first frame after the cover went.
        "launch line in the first frame after the cover": leakedAtUncover.map((s) => ({ leaf: s.leaf, tail: s.tail })),
        "launch line while the cover was still up": leakedAtExit.map((s) => ({ leaf: s.leaf, tail: s.tail })),
        "launch line in the 500ms after": leakedAfter.map((s) => ({ tag: s.tag, leaf: s.leaf, tail: s.tail })),
        firstFrame: (record.atUncover?.samples ?? []).map((s) => ({ leaf: s.leaf, cwd: s.cwd, tail: s.tail })),
      },
      null,
      1,
    ),
  );
  if (bursting) {
    await bursting;
    console.log(`  frames: ${burst.length} in ${dir}`);
  }
  // Let the agent's own screen take over completely before the next round.
  await sleep(1500);
}

console.log(`\nrounds opened: ${results.length}`);
console.log(
  `launch line in the first frame after the cover went: ${results.filter((r) => (r.atUncover?.samples ?? []).some((s) => s.showsLaunch === true)).length} of ${results.length}`,
);
console.log(
  `launch line anywhere in the 500ms after: ${results.filter((r) => r.afterExit.some((s) => s.showsLaunch === true)).length} of ${results.length}`,
);
console.log(
  `covers drawn: ${JSON.stringify(results.map((r) => r.overlayVariant))}; held-back lifts: ${results.reduce((n, r) => n + r.heldBy.length, 0)}; hard caps: ${results.filter((r) => r.hardCap).length}`,
);
console.log(
  `exits: ${JSON.stringify(results.map((r) => ({ what: r.title, rule: r.exit?.exit ?? "none", ms: r.exitAfterMs, uncoveredAt: r.atUncover?.ms ?? null })))}`,
);

// Leave the app as it was found: every tab this probe opened is closed, and its terminal disposed
// first so no agent process is left running behind a dead tab.
const cleanup = await ev(`(async () => {
  const urls = performance.getEntriesByType("resource").map((e) => e.name);
  const find = (p) => { const h = urls.filter((n) => n.includes(p)); return h.filter((n) => n.includes("?t=")).pop() ?? h.pop(); };
  const api = await import(find("/src/modules/terminal/lib/terminalSessionApi.ts"));
  const opened = ${JSON.stringify(results.map((r) => ({ title: r.title, leaf: r.openedLeaf })))};
  const report = [];
  for (const { title, leaf } of opened) {
    if (leaf !== null && leaf !== undefined) report.push({ title, disposed: api.disposeSession(leaf) ?? true });
    else report.push({ title, disposed: "no leaf recorded" });
  }
  await new Promise((r) => setTimeout(r, 800));
  const closed = [];
  for (const { title } of opened) {
    const tab = [...document.querySelectorAll("[data-tab-id]")].find((el) => (el.innerText || "").includes(title));
    if (!tab) { closed.push({ title, closed: false }); continue; }
    const chip = tab.querySelector('[role="button"][aria-label], button[aria-label]');
    const label = chip?.getAttribute("aria-label") ?? null;
    if (chip && /关闭标签页|Close tab/.test(label || "")) {
      const box = chip.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
        chip.dispatchEvent(new MouseEvent(type, init));
      }
      chip.click();
      closed.push({ title, closed: true, label });
    } else {
      closed.push({ title, closed: false, label });
    }
  }
  return JSON.stringify({ disposed: report, closed, tabsLeft: [...document.querySelectorAll("[data-tab-id]")].map((el) => (el.innerText || "").trim().slice(0, 20)) });
})()`);
console.log(`\ncleanup: ${cleanup}`);
socket.close();
