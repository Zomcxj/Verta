// Evaluate one expression inside the running app's own page.
//
// Some questions can only be asked from in there: what the DOM says right now, and the
// app's own Tauri commands. Wrapping the IPC bridge from a probe does not work (the
// internals object is non-writable and non-configurable, so an assignment fails silently),
// but *calling* a command from the page works exactly as the app calls it.
//
// Usage:
//   node scripts/dev/probes/eval.mjs 'return document.documentElement.className'
//   node scripts/dev/probes/eval.mjs path/to/body.js --file
//   node scripts/dev/probes/eval.mjs 'return 1' --port=9223
//
// The body is spliced into an async IIFE, so `return` works and awaits are allowed. The
// result is printed as JSON.
import { readFileSync } from "node:fs";

const arg = (name) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const port = arg("port") ?? "9222";
const fromFile = process.argv.includes("--file");
const body = fromFile
  ? readFileSync(process.argv[2], "utf8")
  : (process.argv[2] ?? "return null;");

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

const result = await send("Runtime.evaluate", {
  expression: `(async () => {\n${body}\n})()`,
  awaitPromise: true,
  returnByValue: true,
});
if (result.result?.exceptionDetails) {
  console.error("页面里抛了：", JSON.stringify(result.result.exceptionDetails, null, 1));
  socket.close();
  process.exit(1);
}
console.log(JSON.stringify(result.result?.result?.value ?? null, null, 1));
socket.close();