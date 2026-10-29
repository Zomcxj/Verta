// Everything the interface threw, watched from outside it.
//
// A renderer that throws without a boundary does not show a stack trace anywhere the user can see: it
// unmounts the tree, and the window is left with whatever was painted last (or nothing but the native
// material behind it). So the only place the reason survives is the browser's own log - which is where
// the `Ghostty terminal model is disposed` that emptied a window was found, through `Log.enable`
// replaying the entries it had already collected.
//
// What it fails on, and what it only prints:
//
//   * an **uncaught exception** fails it, and exits non-zero. That is the thing this exists for: an
//     exception in a render, a commit or a passive effect is what takes a tree down.
//   * `console.error` and log entries at error level are printed as **context** and do not fail it.
//     Deliberate reporting looks exactly like this - the terminal's failure path announces itself with
//     `console.error` on purpose - so a probe that failed on them would fail on a correct build in the
//     very scenario it was built to watch.
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
const exceptions = [];
const reported = [];
const at = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.exceptionThrown") {
    const d = message.params.exceptionDetails;
    const where = (d.stackTrace?.callFrames ?? [])
      .slice(0, 5)
      .map((f) => `${f.functionName || "(anonymous)"} @ ${f.url.split("/").pop()}:${f.lineNumber}`);
    exceptions.push(
      `[${at()}] ${d.exception?.description ?? d.text ?? "(无描述)"}\n     ${where.join("\n     ")}`,
    );
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    reported.push(
      `[${at()}] console.error：${(message.params.args ?? []).map((a) => String(a.value ?? a.description ?? "")).join(" ").slice(0, 300)}`,
    );
  }
  if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
    reported.push(`[${at()}] 日志 error：${(message.params.entry.text ?? "").slice(0, 300)}`);
  }
});

send("Log.enable");
send("Runtime.enable");
// `Log.enable` replays what it already collected, so anything from before this attached still arrives.
await new Promise((r) => setTimeout(r, seconds * 1000));
socket.close();

console.log(
  `看了 ${seconds}s：未捕获异常 ${exceptions.length} 条，另有 ${reported.length} 条 error 级输出（仅上下文）`,
);
if (reported.length > 0) {
  console.log("--- error 级输出（不判失败）---");
  for (const line of reported) console.log(line);
}
if (exceptions.length > 0) {
  console.log("--- 未捕获异常（判失败）---");
  for (const line of exceptions) console.log(line);
}
process.exit(exceptions.length === 0 ? 0 : 1);