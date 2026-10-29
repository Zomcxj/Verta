// Everything the interface threw, watched from outside it.
//
// A renderer that throws without a boundary does not show a stack trace anywhere the user can see: it
// unmounts the tree, and the window is left with whatever was painted last (or nothing but the native
// material behind it). So the only place the reason survives is the browser's own log - which is where
// the `Ghostty terminal model is disposed` that emptied a window was found, through `Log.enable`
// replaying the entries it had already collected.
//
// This enables both domains and prints what arrives: uncaught exceptions, console errors, and log
// entries at warning level and above. It exits non-zero if it saw an uncaught exception or a console
// error, so it can be used as a check rather than only as a readout.
//
// Usage:
//   node scripts/dev/probes/exception-watch.mjs --match=tauri.localhost/ --seconds=60
//   node scripts/dev/probes/exception-watch.mjs --match=tauri.localhost/   # 15 seconds by default
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const match = arg("match");
const seconds = Number(arg("seconds") ?? 15);

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => {
  if (t.type !== "page") return false;
  if (match === null) return t.url.endsWith("1420/") || t.url.endsWith("tauri.localhost/");
  return match.endsWith("/") ? t.url.endsWith(match) : t.url.includes(match);
});
if (!page) {
  console.error("没找到主窗口的 page 目标（app 起来了吗？--match 对吗？）");
  process.exit(2);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
await new Promise((r) => socket.addEventListener("open", () => r()));
const send = (method, params) =>
  socket.send(JSON.stringify({ id: id++, method, params }));

const startedAt = Date.now();
const problems = [];
const at = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.exceptionThrown") {
    const d = message.params.exceptionDetails;
    const where = (d.stackTrace?.callFrames ?? [])
      .slice(0, 4)
      .map((f) => `${f.functionName || "(anonymous)"} @ ${f.url.split("/").pop()}:${f.lineNumber}`);
    problems.push(`[${at()}] 未捕获异常：${d.exception?.description ?? d.text ?? "(无描述)"}\n     ${where.join("\n     ")}`);
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    problems.push(
      `[${at()}] console.error：${(message.params.args ?? []).map((a) => String(a.value ?? a.description ?? "")).join(" ").slice(0, 400)}`,
    );
  }
  if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
    const e = message.params.entry;
    problems.push(`[${at()}] 日志 error：${(e.text ?? "").slice(0, 400)}`);
  }
});

send("Log.enable");
send("Runtime.enable");
// `Log.enable` replays what it already collected, so anything from before this attached still arrives.
await new Promise((r) => setTimeout(r, seconds * 1000));
socket.close();

console.log(`看了 ${seconds}s：${problems.length === 0 ? "没有未捕获异常 / console.error" : `${problems.length} 条`}`);
for (const p of problems) console.log(p);
process.exit(problems.length === 0 ? 0 : 1);