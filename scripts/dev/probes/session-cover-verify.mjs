// Opens one session from the list and reports where the cover lifted, judged against both rules.
// Needs the session list to be visible; the caller passes the title to click.
const title = process.argv.find((a) => a.startsWith("--title="))?.slice(8) ?? null;
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) {
  console.error("没找到主窗口");
  process.exit(1);
}
const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
await new Promise((res, rej) => {
  socket.addEventListener("open", () => res());
  socket.addEventListener("error", (e) => rej(new Error(String(e.message ?? e))));
});
socket.addEventListener("message", (event) => {
  const m = JSON.parse(event.data);
  const entry = pending.get(m.id);
  if (!entry) return;
  pending.delete(m.id);
  if (m.error) entry.reject(new Error(JSON.stringify(m.error)));
  else entry.resolve(m.result);
});
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails),
    );
  }
  return r.result.value;
};

// Clear the trace, then click the session row whose text contains the title.
const clicked = await evaluate(`(async () => {
  window.__vertaOpenTrace = [];
  const rows = [...document.querySelectorAll("[data-session-row], [data-session-title], li, button")];
  const wanted = ${JSON.stringify(title)};
  const row = rows.find((el) => wanted && el.textContent && el.textContent.includes(wanted));
  if (!row) return { ok: false, sample: rows.slice(0, 12).map((el) => el.textContent.trim().slice(0, 40)) };
  for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    row.dispatchEvent(new MouseEvent(t, { bubbles: true }));
  }
  row.click();
  return { ok: true };
})()`);
if (!clicked.ok) {
  console.log(JSON.stringify({ stage: "click", ...clicked }, null, 1));
  process.exit(0);
}
await new Promise((r) => setTimeout(r, 16000));

const verdict = await evaluate(`(() => {
  const trace = window.__vertaOpenTrace ?? [];
  const ticks = trace.filter((e) => e.t !== undefined && !e.exit);
  const exits = trace.filter((e) => e.exit);
  const oldRule = (x) => x.bytes >= 512 && x.silentFor >= 500 && x.t >= 1500;
  const newRule = (x) => oldRule(x) && !x.showsLaunch;
  return {
    exit: exits[exits.length - 1] ?? null,
    // Lifting while the command was on screen is the defect being fixed.
    liftedWithLaunchVisible:
      (exits[exits.length - 1]?.exit === "silence") &&
      ticks.some((x) => oldRule(x) && x.showsLaunch && x.t === exits[exits.length - 1]?.t),
    oldWouldFireWithLaunch: ticks.filter((x) => oldRule(x) && x.showsLaunch).map((x) => x.t),
    newWouldFire: ticks.filter(newRule).map((x) => x.t),
    screenAtEnd: ticks.length ? ticks[ticks.length - 1].screenTail : null,
  };
})()`);
console.log(JSON.stringify(verdict, null, 1));
