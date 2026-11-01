// Watches a turn that is still running: does the panel keep its row lit when nothing has been written
// for longer than the write window?
//
// A row is lit for one of two reasons. The store was written recently - `ACTIVE_WINDOW_BY_TOOL`, three
// minutes, measured from the gaps between writes inside a turn - or the opencode service says the
// session's turn has not finished. The second one is what this watches: its whole purpose is the case
// the first one cannot answer, a turn that spends longer than three minutes inside one tool call
// without writing anything. A single reading once showed a row lit for that reason alone; this is the
// same reading taken every thirty seconds, so the answer is "it stays lit" rather than "it was lit".
//
// It reads three things per sample, all read-only: what the app's own service read returns (the same
// call the panel makes on its tick), what the panel actually drew for each row, and how old each
// session's last write is. A sample counts as decisive when a session is mid-turn, its last write is
// older than the window, and its row is still drawn as running: at that moment the write times alone
// would have left the row dark.
//
// The reverse is recorded too, because it needs a real turn to end and nothing can arrange that: every
// session once seen mid-turn is watched afterwards, and the sample where its row stops carrying a
// state is kept with what the service said about it then and how old its last write was. "The turn
// ended and the row went dark" and "the row went dark while the service still said it was running" are
// the same event on screen and different answers, so the difference is written down.
//
// A row that is missing from the document is neither of those. Measured on this machine, a session
// that was mid-turn was absent for one sample while the panel redrew and back on the next, with the
// same store and the same service answer on either side of it. Those samples are counted and set
// aside rather than read as the row going dark, which would invent the very event this is for.
//
// Usage:
//   node scripts/dev/probes/service-kept-lit-watch.mjs
//   node scripts/dev/probes/service-kept-lit-watch.mjs --minutes=6 --every=30
//
// Exit codes: 0 the row stayed lit on the service's word (and the number of samples is reported),
// 1 the row went dark while the service still said the turn was running, 2 nothing to watch (no panel,
// or no session was mid-turn at all), 3 the situation never arose within the time given - which is not
// a pass, and says so rather than reporting the claim as verified, 4 the row was seen going dark but
// no sample showed a row outsitting the write window, which is the other half of the same question.
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const minutes = Number(arg("minutes", "6"));
const everySeconds = Number(arg("every", "30"));
const match = arg("match", null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const findTarget = async () => {
  const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
  return targets.find((t) => {
    if (t.type !== "page") return false;
    if (match === null) return t.url.endsWith("1420/") || t.url.endsWith("tauri.localhost/");
    return match.endsWith("/") ? t.url.endsWith(match) : t.url.includes(match);
  });
};

// The page can be reloaded underneath a long watch - writing any file the app imports makes Vite
// redraw it, and a reload destroys the evaluation context, which ended this watch after seven
// samples the first time it was run for forty minutes. The window is reopened and the sample taken
// again; nothing is lost, because a sample imports everything it needs on every call and holds no
// state of its own.
let socket = null;
let id = 1;
let pending = new Map();
let reloads = 0;
const connect = async () => {
  const target = await findTarget();
  if (!target) throw new Error("没找到主窗口的 page 目标（dev 起来了吗？--match 对吗？）");
  const fresh = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    fresh.addEventListener("open", () => resolve());
    fresh.addEventListener("error", () => reject(new Error("WebSocket 打不开")));
  });
  fresh.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    const q = pending.get(m.id);
    if (q) {
      pending.delete(m.id);
      q(m);
    }
  });
  socket = fresh;
  pending = new Map();
};
try {
  await connect();
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(2);
}

const send = (method, params) =>
  new Promise((res, rej) => {
    const i = id++;
    pending.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    socket.send(JSON.stringify({ id: i, method, params }));
  });
const CONTEXT_GONE =
  /Execution context was destroyed|Cannot find context|Target closed|Session closed|navigated|WebSocket is not open/;
const evalIn = async (body) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const r = await send("Runtime.evaluate", {
        expression: `(async () => {\n${body}\n})()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      }
      return r.result.value;
    } catch (error) {
      if (attempt >= 3 || !CONTEXT_GONE.test(String(error?.message ?? error))) throw error;
      reloads += 1;
      console.log(`（页面被重载了，重开一次调试目标再采这一格：第 ${reloads} 次）`);
      try {
        socket?.close();
      } catch {}
      await sleep(1500);
      await connect();
    }
  }
};

/** What the app knows right now: the service's answer, the store's rows, and what the panel drew. */
const SAMPLE = `
  const urls = performance.getEntriesByType("resource").map((x) => x.name);
  const find = (p) => {
    const hits = urls.filter((n) => n.includes(p));
    return hits.find((n) => n.includes("?t=")) ?? hits[0] ?? ("/src/" + p);
  };
  const sessions = await import(find("modules/launcher/lib/sessions.ts"));
  const activity = await import(find("modules/launcher/lib/sessionActivity.ts"));
  const running = await sessions.runningAgentSessionIds(null);
  const all = await sessions.loadAllAgentSessions();
  const rows = [...document.querySelectorAll("[data-session-id]")].map((row) => ({
    id: row.getAttribute("data-session-id"),
    state: row.querySelector("[data-agent-state]")?.getAttribute("data-agent-state") ?? null,
    width: Math.round(row.getBoundingClientRect().width),
  }));
  const now = Date.now();
  return JSON.stringify({
    serviceIds: running,
    windowMs: activity.ACTIVE_WINDOW_BY_TOOL.opencode,
    rows,
    sessions: all.sessions.map((s) => ({
      id: s.id,
      tool: s.tool,
      title: s.title.slice(0, 22),
      parentId: s.parentId,
      writeAgeMs: now - s.updatedAtMs,
    })),
  });
`;

const { statSync } = await import("node:fs");
const { join } = await import("node:path");
const { homedir } = await import("node:os");
const storeFile = join(homedir(), ".local", "share", "opencode", "opencode.db");
const storeStamp = () => {
  try {
    const s = statSync(storeFile);
    return { mtime: s.mtime.toISOString().slice(11, 19), size: s.size };
  } catch {
    return null;
  }
};

const readPanelWidth = async () =>
  Number(
    await evalIn(`
      const row = document.querySelector("[data-session-id]");
      return row ? String(Math.round(row.getBoundingClientRect().width)) : "0";
    `),
  );
// A watch is normally started right after a reload, and right after a reload the panel has not read
// its sources yet: the list is empty for a few seconds on this machine, the slowest source being pi
// at about 3.3s. Looking once and exiting on an empty list confuses "you never opened the panel" with
// "you were a second early", which is what a forty minute run did the first time it was started this
// way. So the first row is waited for, and only its absence for twenty seconds is a refusal.
let panelWidth = 0;
for (let attempt = 0; attempt < 20 && panelWidth === 0; attempt += 1) {
  if (attempt > 0) await sleep(1000);
  panelWidth = await readPanelWidth();
}
if (panelWidth === 0) {
  console.error("会话面板没开（等了 20 秒也没有 [data-session-id]）：先把左栏切到「会话」再跑这个探针。");
  process.exit(2);
}
if (panelWidth < 60) {
  console.error(`会话面板是收起的（行宽 ${panelWidth}px）：先展开侧栏再跑。`);
  process.exit(2);
}

// A row that stops being lit is the other half of the same question, and it is the half that needs a
// real turn to end rather than anything this probe can arrange. Every session the service reported
// mid-turn is tracked afterwards, and the sample where its row first stops carrying a state is
// recorded with what the service said about it at that moment and how old its last write was. That
// is the difference between "the turn ended and the row went dark" and "the row went dark while the
// service still said the turn was running", which is a failure below.
//
// A row that is not in the document at all is a third thing, and it is not a dark row: measured on
// this machine, a session mid-turn was absent from the list for one sample while the panel was
// redrawing and back in it on the next, with the same store and the same service answer either side.
// So absence is recorded as its own reading and the last state the row was seen in is carried over;
// reading "the row is gone" as "the row went dark" would invent the event this half exists to catch.
const LIT = new Set([
  "background",
  "working",
  "attention",
  "idle",
  "finished",
  "trailing",
]);
const tracked = new Map();
const wasLit = new Map();
const darkenings = [];
const rowOf = (rows, id) => {
  const row = rows.find((r) => r.id === id);
  return row === undefined ? { drawn: false, state: null } : { drawn: true, state: row.state };
};
let notDrawn = 0;

const deadline = Date.now() + minutes * 60_000;
const startedAt = Date.now();
const samples = [];
let sawAnyMidTurn = false;
let cutShort = false;
try {
  while (Date.now() < deadline) {
    const raw = JSON.parse(await evalIn(SAMPLE));
    const ids = new Set(raw.serviceIds ?? []);
    const store = storeStamp();
    const midTurn = raw.sessions
      .filter((s) => ids.has(s.id) && s.parentId === null)
      .map((s) => {
        const row = rowOf(raw.rows, s.id);
        if (!row.drawn) notDrawn += 1;
        return {
          id: s.id,
          title: s.title,
          writeAgeMinutes: Math.round((s.writeAgeMs / 60000) * 10) / 10,
          drawn: row.drawn,
          rowState: row.drawn ? row.state : "not-drawn",
          beyondWindow: s.writeAgeMs > raw.windowMs,
        };
      });
    for (const m of midTurn) {
      tracked.set(m.id, m.title);
      if (!wasLit.has(m.id) && m.drawn) wasLit.set(m.id, m.rowState);
    }
    // Sessions that were mid-turn once and are not any more are still watched: this is where a row
    // that stayed lit by the write times alone is expected to go dark, three minutes after its last
    // write. The moment is recorded either way, with the reason attached.
    const at = new Date().toISOString().slice(11, 19);
    for (const [id, title] of tracked) {
      const session = raw.sessions.find((s) => s.id === id);
      const row = rowOf(raw.rows, id);
      if (!row.drawn) continue;
      const previous = wasLit.get(id);
      if (previous !== undefined && LIT.has(previous) && !LIT.has(row.state)) {
        darkenings.push({
          at,
          id,
          title,
          from: previous,
          to: row.state === null ? "无标记" : row.state,
          serviceStillReports: ids.has(id),
          writeAgeMinutes:
            session === undefined ? null : Math.round((session.writeAgeMs / 60000) * 10) / 10,
        });
      }
      if (LIT.has(row.state)) wasLit.set(id, row.state);
      else wasLit.delete(id);
    }
    const sample = {
      at,
      serviceIds: raw.serviceIds,
      store,
      midTurn,
    };
    samples.push(sample);
    if (midTurn.length > 0) sawAnyMidTurn = true;
    console.log(
      `${sample.at}  服务报 ${raw.serviceIds === null ? "问不到" : raw.serviceIds.length} 个在跑  ` +
        `store ${store ? store.mtime : "?"}  ` +
        (midTurn.length === 0
          ? "（此刻没有已在跑的顶层会话）"
          : midTurn
              .map(
                (m) =>
                  `${m.title} 写龄 ${m.writeAgeMinutes}min 行上 ${m.rowState}${m.beyondWindow ? "  ← 已超写窗口" : ""}`,
              )
              .join("  |  ")),
    );
    await sleep(everySeconds * 1000);
  }
} catch (error) {
  cutShort = true;
  console.error(`采样中断：${String(error?.message ?? error)}`);
}
const observedMinutes = Math.round(((Date.now() - startedAt) / 60000) * 10) / 10;

// The decisive samples: mid-turn, past the write window, and drawn as running anyway. A sample where
// the row was not drawn at all decides nothing and is counted on its own.
//
// Which state the row was drawn in is kept, because the claim this probe makes is about the
// service's word keeping the row lit: `background` is the row the panel folds out of the write times
// and the service answer, so that is the decisive one. A row drawn as work in flight or as
// background work is lit for a reason of its own (the screen says so), which is worth reporting but
// is not this claim; a row drawn green, or drawn with no marker at all, while the service says a
// turn is running is the fault this probe exists for.
const decisive = [];
const litByScreen = [];
const failures = [];
let undecided = 0;
for (const sample of samples) {
  for (const m of sample.midTurn) {
    if (!m.drawn) {
      if (m.beyondWindow) undecided += 1;
      continue;
    }
    if (!m.beyondWindow) continue;
    if (m.rowState === "background") decisive.push({ at: sample.at, ...m });
    else if (
      m.rowState === "working" ||
      m.rowState === "attention" ||
      m.rowState === "trailing"
    )
      litByScreen.push({ at: sample.at, ...m });
    else failures.push({ at: sample.at, ...m });
  }
}

console.log(
  `\n采样 ${samples.length} 次（实际盯了 ${observedMinutes} 分钟，要的是 ${minutes} 分钟${reloads > 0 ? `，期间页面被重载 ${reloads} 次并各重采一次` : ""}），` +
    `其中 ${samples.filter((s) => s.midTurn.length > 0).length} 次有已在跑的顶层会话。`,
);
console.log(
  `这些采样里有 ${notDrawn} 行次「这一格根本没画出来」（面板重绘的瞬间，不是灭）` +
    (undecided > 0 ? `，其中 ${undecided} 行次已超写窗口、因此这一遍判不了` : "") +
    "。",
);
console.log(
  decisive.length > 0
    ? `写窗口之外仍亮着（只可能因为服务判据）共 ${decisive.length} 次：${decisive.map((d) => `${d.at} ${d.title} 写龄 ${d.writeAgeMinutes}min`).join("；")}`
    : "没有出现「写龄超出写窗口」的采样。",
);
if (litByScreen.length > 0) {
  console.log(
    `另外有 ${litByScreen.length} 行次在写窗口之外仍亮，但亮的原因是**屏幕自己**说的（行上是 ${[...new Set(litByScreen.map((m) => m.rowState))].join("/")}）：` +
      litByScreen
        .map((m) => `${m.at} ${m.title} 行上 ${m.rowState}`)
        .join("；"),
  );
}
if (darkenings.length > 0) {
  console.log(`\n看到 ${darkenings.length} 次「行由亮转灭」，每次都带当时服务怎么说与写龄：`);
  for (const d of darkenings) {
    console.log(
      `  - ${d.at} ${d.title}（${d.from} → ${d.to}）  服务此刻${d.serviceStillReports ? "仍报在跑" : "已不报在跑"}  ` +
        `最后写盘 ${d.writeAgeMinutes === null ? "未知" : `${d.writeAgeMinutes}min 前`}`,
    );
  }
} else {
  console.log("\n这一次没有看到「行由亮转灭」（要等某条真跑完并过了写窗口）。");
}

socket?.close();
// What actually happened, not what was asked for: the watch used to be ended early by a page reload
// and then report the configured window as if it had been watched, which reads as "nothing happened
// in forty minutes" when only two had passed.
const windowText = cutShort
  ? `这一遍只盯了 ${observedMinutes} 分钟就断了（要的是 ${minutes} 分钟）`
  : `${observedMinutes} 分钟里`;
if (failures.length > 0) {
  console.log("\n不通过：服务还报在跑，行却已经灭了：");
  for (const f of failures) console.log(`  - ${f.at} ${f.title} 写龄 ${f.writeAgeMinutes}min 行上 ${f.rowState}`);
  process.exit(1);
}
if (decisive.length > 0) {
  console.log("\n通过：服务说在跑的会话，写盘早已超出写窗口，行依旧亮着。");
  process.exit(0);
}
if (darkenings.length > 0) {
  console.log(
    "\n这一遍证到的是反向那一半：行确实由亮转灭，并且每一刻都记下了当时服务怎么说、写龄多久；" +
      "但「写龄超出写窗口时服务仍报在跑、行依旧亮着」这一幕没有出现，所以那一条没有被这一遍证到。",
  );
  process.exit(4);
}
console.error(
  sawAnyMidTurn
    ? `\n没有通过：${windowText}没有出现「写龄超过写窗口而服务仍在报在跑」的采样，所以这一条还没被证到。`
    : `\n没有通过：${windowText}服务一次都没报「有会话在跑」，没有可盯的对象。`,
);
process.exit(3);
