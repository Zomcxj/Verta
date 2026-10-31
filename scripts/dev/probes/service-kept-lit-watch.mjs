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
// Usage:
//   node scripts/dev/probes/service-kept-lit-watch.mjs
//   node scripts/dev/probes/service-kept-lit-watch.mjs --minutes=6 --every=30
//
// Exit codes: 0 the row stayed lit on the service's word (and the number of samples is reported),
// 1 the row went dark while the service still said the turn was running, 2 nothing to watch (no panel,
// or no session was mid-turn at all), 3 the situation never arose within the time given - which is not
// a pass, and says so rather than reporting the claim as verified.
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const minutes = Number(arg("minutes", "6"));
const everySeconds = Number(arg("every", "30"));
const match = arg("match", null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const target = targets.find((t) => {
  if (t.type !== "page") return false;
  if (match === null) return t.url.endsWith("1420/") || t.url.endsWith("tauri.localhost/");
  return match.endsWith("/") ? t.url.endsWith(match) : t.url.includes(match);
});
if (!target) {
  console.error("没找到主窗口的 page 目标（dev 起来了吗？--match 对吗？）");
  process.exit(2);
}
const socket = new WebSocket(target.webSocketDebuggerUrl);
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
  new Promise((res, rej) => {
    const i = id++;
    pending.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    socket.send(JSON.stringify({ id: i, method, params }));
  });
const evalIn = async (body) => {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => {\n${body}\n})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
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

const panelWidth = Number(
  await evalIn(`
    const row = document.querySelector("[data-session-id]");
    return row ? String(Math.round(row.getBoundingClientRect().width)) : "0";
  `),
);
if (panelWidth === 0) {
  console.error("会话面板没开（找不到 [data-session-id]）：先把左栏切到「会话」再跑这个探针。");
  process.exit(2);
}
if (panelWidth < 60) {
  console.error(`会话面板是收起的（行宽 ${panelWidth}px）：先展开侧栏再跑。`);
  process.exit(2);
}

const deadline = Date.now() + minutes * 60_000;
const samples = [];
let sawAnyMidTurn = false;
try {
  while (Date.now() < deadline) {
    const raw = JSON.parse(await evalIn(SAMPLE));
    const ids = new Set(raw.serviceIds ?? []);
    const store = storeStamp();
    const midTurn = raw.sessions
      .filter((s) => ids.has(s.id) && s.parentId === null)
      .map((s) => ({
        id: s.id,
        title: s.title,
        writeAgeMinutes: Math.round((s.writeAgeMs / 60000) * 10) / 10,
        rowState: raw.rows.find((r) => r.id === s.id)?.state ?? "no-row",
        beyondWindow: s.writeAgeMs > raw.windowMs,
      }));
    const sample = {
      at: new Date().toISOString().slice(11, 19),
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
  console.error(`采样中断：${String(error?.message ?? error)}`);
}

// The decisive samples: mid-turn, past the write window, and drawn as running anyway.
const decisive = [];
const failures = [];
for (const sample of samples) {
  for (const m of sample.midTurn) {
    if (!m.beyondWindow) continue;
    if (m.rowState === "background") decisive.push({ at: sample.at, ...m });
    else failures.push({ at: sample.at, ...m });
  }
}

console.log(`\n采样 ${samples.length} 次，其中 ${samples.filter((s) => s.midTurn.length > 0).length} 次有已在跑的顶层会话。`);
console.log(
  decisive.length > 0
    ? `写窗口之外仍亮着（只可能因为服务判据）共 ${decisive.length} 次：${decisive.map((d) => `${d.at} ${d.title} 写龄 ${d.writeAgeMinutes}min`).join("；")}`
    : "没有出现「写龄超出写窗口」的采样。",
);

socket.close();
if (failures.length > 0) {
  console.log("\n不通过：服务还报在跑，行却已经灭了：");
  for (const f of failures) console.log(`  - ${f.at} ${f.title} 写龄 ${f.writeAgeMinutes}min 行上 ${f.rowState}`);
  process.exit(1);
}
if (decisive.length > 0) {
  console.log("\n通过：服务说在跑的会话，写盘早已超出写窗口，行依旧亮着。");
  process.exit(0);
}
console.error(
  sawAnyMidTurn
    ? `\n没有通过：${minutes} 分钟里没有出现「写龄超过写窗口而服务仍在报在跑」的采样，所以这一条还没被证到。`
    : `\n没有通过：${minutes} 分钟里服务一次都没报「有会话在跑」，没有可盯的对象。`,
);
process.exit(3);
