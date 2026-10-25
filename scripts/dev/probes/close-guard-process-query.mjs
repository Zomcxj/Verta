// "Is a command still running in this terminal?" is what the close guard asks before
// letting the window go, and on Windows the answer decides whether the user sees a
// prompt at all: `confirmCloseRunningTerminal` defaults to on, so the guard runs on
// every close.
//
// This reads the two native answers for every live terminal next to what its screen
// actually shows. A terminal sitting at a prompt with the two queries saying "yes,
// something is running" is the false positive, and it is here rather than in a unit
// test because the query is a kernel fact, not a function of the app's own state.
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
await send("Page.bringToFront");
console.log(
  await pageEval(`
    const NEWLINE = String.fromCharCode(10);
    const urls = performance.getEntriesByType("resource").map((e) => e.name);
    const find = (p) => { const hits = urls.filter((n) => n.includes("/src/" + p)); return hits.find((n) => n.includes("?t=")) ?? hits[0] ?? ("/src/" + p); };
    const api = await import(find("modules/terminal/lib/terminalSessionApi.ts"));
    const sessions = await import(find("modules/terminal/ghostty/useGhosttyTerminalSession.ts"));
    const out = [];
    for (const session of sessions.ghosttySessionDiagnostics()) {
      const pty = session.pty;
      let process = "err";
      let job = "err";
      if (pty !== null) {
        try { process = await window.__TAURI_INTERNALS__.invoke("pty_has_foreground_process", { id: pty }); } catch (error) { process = String(error); }
        try { job = await window.__TAURI_INTERNALS__.invoke("pty_has_foreground_job", { id: pty }); } catch (error) { job = String(error); }
      }
      const tail = api.leafScreenTail(session.leafId) ?? "";
      const lines = tail.split(NEWLINE).map((l) => l.trim()).filter(Boolean);
      out.push({
        leafId: session.leafId,
        pty,
        visible: session.visible,
        shellExited: session.shellExited,
        hasForegroundProcess: process,
        hasForegroundJob: job,
        screenTail: lines.slice(-3)
      });
    }
    return JSON.stringify(out, null, 1);
  `),
);
socket.close();