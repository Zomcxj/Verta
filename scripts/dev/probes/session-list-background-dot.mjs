// Does the session list mark an opencode session the user never opened a tab for?
//
// The report (2026-10-27): "后台运行的 opencode（服务模式、不打开终端）也要在会话列表处显示橙色呼吸灯". The
// list already has two sources it can name a session from - when it was last written, and what the
// service answers on `GET /api/session/active` - so before writing a third one this reads what the
// rows actually draw, and what each source said.
//
// The probe opens the session list, waits for the rows to settle, and records for every row: its
// state as drawn (the marquee), what the service says, and the age of its last write. It never
// opens a session and never writes one; the only thing it touches is the view.
//
// Usage: node scripts/dev/probes/session-list-background-dot.mjs
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) {
  console.error("dev 起来了？没找到主窗口的 page 目标。");
  process.exit(1);
}
const socket = new WebSocket(page.webSocketDebuggerUrl);
let seq = 1;
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
    const i = seq++;
    pending.set(i, res);
    socket.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(ex.exception?.description ?? ex.text);
  return r.result?.result?.value;
};

// The session list has to be the view on screen for its rows to exist.
const listed = await ev(`(async () => {
  const press = (node) => {
    const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
    node.dispatchEvent(new PointerEvent("pointerdown", opts));
    node.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
    node.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
  };
  for (let i = 0; i < 24; i++) {
    if (document.querySelector("[data-session-id]")) return "listed";
    const tab = [...document.querySelectorAll("button")].find((b) => /^(会话|Sessions)$/.test((b.textContent || "").trim()));
    if (tab) press(tab);
    await new Promise((r) => setTimeout(r, 250));
  }
  return "no session rows";
})()`);
console.log(`session list: ${listed}`);
if (listed !== "listed") {
  socket.close();
  process.exit(1);
}

// Let the tick that asks the service run at least once.
await sleep(2500);

// What each source says, asked directly: the service's own answer, and the rows' last write times.
const sources = JSON.parse(
  await ev(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    let running = null;
    let error = null;
    try {
      running = await invoke("agent_sessions_running", { distro: null });
    } catch (e) {
      error = String(e);
    }
    return JSON.stringify({ running, error });
  })()`),
);
console.log(`service says running: ${JSON.stringify(sources.running)}${sources.error ? ` (error: ${sources.error})` : ""}`);

// What the rows draw: the marquee carries the state, the row carries the id.
const rows = JSON.parse(
  await ev(`JSON.stringify([...document.querySelectorAll("[data-session-id]")].map((row) => {
    const marquee = row.querySelector("[data-agent-marquee], [data-agent-state]");
    return {
      id: row.getAttribute("data-session-id"),
      title: (row.innerText || "").split("\\n")[0].trim().slice(0, 40),
      state: marquee?.getAttribute("data-agent-state") ?? null,
      hasBar: Boolean(marquee),
    };
  }))`),
);
console.log(`rows drawn: ${rows.length}`);
for (const row of rows.slice(0, 12)) {
  console.log(`  ${row.id}  state=${row.state ?? "—"}  ${row.title}`);
}

const running = sources.running ?? [];
const marked = new Set(rows.filter((r) => r.state !== null).map((r) => r.id));
const runningButUnmarked = running.filter((id) => !marked.has(id));
console.log(
  running.length === 0
    ? "\nNOTHING TO MEASURE: the service says no session is running right now, so there is no row to light."
    : runningButUnmarked.length === 0
      ? `\nPASS: every session the service calls running is drawn: ${JSON.stringify(running)}.`
      : `\nFAIL: ${JSON.stringify(runningButUnmarked)} running by the service, no mark on the row.`,
);

socket.close();
process.exit(runningButUnmarked.length === 0 ? 0 : 1);
