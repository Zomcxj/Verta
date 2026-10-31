// Records every session-store read from a cold start, with the source it asked for and how long it
// took. The question this answers is whether a distro read is made at startup at all, and if so in
// what order relative to this machine's.
//
// It hooks `window.fetch`, which is where the IPC actually goes: the front end calls the backend
// through the `ipc.localhost` scheme, with the command's arguments as the request body. This used to
// hook `window.__TAURI_INTERNALS__.invoke` instead, and reported no reads at all on every run - that
// property is an own, non-writable, non-configurable one (`Object.getOwnPropertyDescriptor` says so,
// and 601 retries left it unchanged), so the assignment was silently dropped and the probe measured
// nothing while looking like it had. `session-reading-cold-start.mjs` covers what the panel drew during
// these same reads.
//
// Usage: node scripts/dev/probes/session-cold-start.mjs
//
// The page is reloaded, which is a cold start of the front end: the in-memory list it keeps across a
// remount is gone, so the reads below are the first ones. The application itself has to be running.
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
const started = [];
const settled = [];
await new Promise((r) => socket.addEventListener("open", () => r()));
socket.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.consoleAPICalled") {
    for (const a of m.params.args ?? []) {
      if (typeof a.value !== "string") continue;
      if (a.value.startsWith("COLD ")) started.push(JSON.parse(a.value.slice(5)));
      if (a.value.startsWith("COLD-DONE ")) settled.push(JSON.parse(a.value.slice(10)));
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
      const original = window.fetch;
      window.fetch = function (input, init) {
        const url = typeof input === "string" ? input : (input && input.url) || String(input);
        const match = /agent_sessions_list|wsl_list_distros/.exec(url);
        if (!match) return original.apply(this, arguments);
        let args = null;
        try {
          args = init && typeof init.body === "string" ? JSON.parse(init.body) : null;
        } catch {}
        const at = Math.round(performance.now() - t0);
        console.log("COLD " + JSON.stringify({
          at,
          cmd: match[0],
          distro: (args && args.distro) || null,
          tool: (args && args.tool) || null,
        }));
        // One more line when it comes back, so the wait each source cost is measured rather than
        // assumed from the order the rows appeared in.
        const report = (done, error) => {
          console.log("COLD-DONE " + JSON.stringify({ at, done, cmd: match[0], error: error ?? null }));
        };
        return original.apply(this, arguments).then(
          (value) => {
            report(Math.round(performance.now() - t0), null);
            return value;
          },
          (error) => {
            report(Math.round(performance.now() - t0), String(error && error.message ? error.message : error));
            throw error;
          },
        );
      };
    })();
  `,
});
await send("Page.reload", { ignoreCache: false });
await new Promise((r) => setTimeout(r, 16000));

const reads = started.filter((e) => e.cmd === "agent_sessions_list");
console.log(`session 读取 ${reads.length} 次：`);
for (const e of reads) {
  const done = settled.find((s) => s.at === e.at && s.cmd === e.cmd);
  const took = done ? `${done.done - e.at}ms` : "还没回来";
  console.log(
    `  +${String(e.at).padStart(6)}ms  ${e.tool}  ${e.distro ?? "本机"}  ${took}${done?.error ? `  失败：${done.error}` : ""}`,
  );
}
const distros = started.filter((e) => e.cmd === "wsl_list_distros");
if (distros.length > 0) {
  console.log(`\n发行版枚举 ${distros.length} 次（首次 +${distros[0].at}ms）`);
}
const wanted = reads.some((e) => e.distro !== null);
console.log(wanted ? "\n冷启动里确实有一次带 WSL 的读取" : "\n冷启动里没有任何 WSL 读取");
if (reads.length === 0) {
  console.error("一次读取都没记到：先看 WSL 开关是否打开、后端是否在跑。");
  process.exit(1);
}
socket.close();
