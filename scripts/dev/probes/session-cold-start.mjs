// Records every session-store read from a cold start, with the source it asked for.
//
// Hooks `__TAURI_INTERNALS__.invoke` before the page boots (so the hook survives the reload that
// starts the run) and logs each call to the session commands with a timestamp. The question this
// answers is whether a distro read is made at startup at all, and if so in what order relative to
// the first paint.
//
// Usage: node scripts/dev/probes/session-cold-start.mjs
const target = (await (await fetch("http://127.0.0.1:9222/json")).json()).find(
  (t) => t.type === "page" && t.url === "http://localhost:1420/",
);
if (!target) {
  console.error("没找到 dev 页面（9222）");
  process.exit(1);
}
const socket = new WebSocket(target.webSocketDebuggerUrl);
let id = 1;
const pending = new Map();
const seen = [];
await new Promise((r) => socket.addEventListener("open", () => r()));
socket.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.consoleAPICalled") {
    for (const a of m.params.args ?? []) {
      if (typeof a.value === "string" && a.value.startsWith("COLD ")) {
        seen.push(JSON.parse(a.value.slice(5)));
      }
    }
    return;
  }
  pending.get(m.id)?.(m);
  pending.delete(m.id);
});
const send = (method, params) =>
  new Promise((res) => {
    const i = id++;
    pending.set(i, res);
    socket.send(JSON.stringify({ id: i, method, params }));
  });

await send("Runtime.enable");
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    (() => {
      const t0 = performance.now();
      const internals = window.__TAURI_INTERNALS__;
      if (!internals || !internals.invoke) return;
      const original = internals.invoke.bind(internals);
      internals.invoke = (cmd, args, options) => {
        if (cmd === "agent_sessions_list" || cmd === "wsl_list_distros") {
          console.log("COLD " + JSON.stringify({
            at: Math.round(performance.now() - t0),
            cmd,
            distro: args?.distro ?? null,
            tool: args?.tool ?? null,
          }));
        }
        return original(cmd, args, options);
      };
    })();
  `,
});
await send("Page.reload", { ignoreCache: false });
await new Promise((r) => setTimeout(r, 16000));

const reads = seen.filter((e) => e.cmd === "agent_sessions_list");
console.log(`session 读取 ${reads.length} 次：`);
for (const e of reads) {
  console.log(`  +${String(e.at).padStart(6)}ms  ${e.tool}  ${e.distro ?? "本机"}`);
}
const wanted = reads.some((e) => e.distro !== null);
console.log(wanted ? "\n冷启动里确实有一次带 WSL 的读取" : "\n冷启动里没有任何 WSL 读取");
socket.close();
