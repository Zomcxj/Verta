// Watch one session opening, sampling what the cover waits on, so the moment it lifts can be
// judged from measurements instead of from reading the code again.
//
// The cover (SessionOpeningOverlay) is supposed to stay up until the agent has taken the
// screen over. This prints, every tick: whether the leaf is on the alternate screen, how many
// bytes it has taken in since the command was written, whether the launch command is still
// on the visible screen, and whether the cover is still drawn. The tick where the cover goes
// away is the one to look at.
//
// Usage: node scripts/dev/probes/session-open-watch.mjs --title="<session title>" [--ms=9000]
//
// The session list must be open and the named row visible.
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const title =
  process.argv.find((a) => a.startsWith("--title="))?.slice(8) ?? null;
const totalMs = Number(
  process.argv.find((a) => a.startsWith("--ms="))?.slice(5) ?? "9000",
);

if (!title) {
  console.error('用法: node scripts/dev/probes/session-open-watch.mjs --title="会话标题"');
  process.exit(2);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) {
  console.error("没找到主窗口；dev 起了吗？");
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
await new Promise((resolve, reject) => {
  socket.addEventListener("open", () => resolve());
  socket.addEventListener("error", (e) => reject(new Error(String(e.message ?? e))));
});
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
  else entry.resolve(message.result);
});
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "页面内异常",
    );
  }
  return result.result.value;
};

try {
  // Click the row, then start sampling right away.
  const clicked = await evaluate(`(() => {
    const row = [...document.querySelectorAll("button, div, li")].find((n) => {
      const text = (n.textContent || "").trim();
      return text.includes(${JSON.stringify(title)}) && n.getAttribute("role") !== undefined;
    });
    if (!row) return false;
    row.click();
    return true;
  })()`);
  if (!clicked) {
    console.error(`列表里没找到「${title}」那一行`);
    process.exit(3);
  }

  const samples = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < totalMs) {
    // The cover is a full-surface element; read it, plus the visible screen and the byte count
    // through the app's own DEV accessors when they are present.
    const state = await evaluate(`(() => {
      const cover = [...document.querySelectorAll("*")].find((n) => {
        const cls = (n.getAttribute("class") || "");
        return cls.includes("session-opening") || (n.getAttribute("data-session-opening") !== null);
      });
      const screen = window.__vertaLeafScreenTail ? window.__vertaLeafScreenTail() : null;
      return JSON.stringify({
        coverVisible: Boolean(cover),
        coverClass: cover ? (cover.getAttribute("class") || "").slice(0, 60) : null,
        screenTail: screen ? screen.slice(-220) : null,
      });
    })()`);
    const parsed = JSON.parse(state);
    samples.push({
      t: Date.now() - startedAt,
      ...parsed,
    });
    await sleep(150);
  }

  // Print a compact table: only the ticks where something changed, plus the first and last.
  const keep = samples.filter((s, i) => {
    if (i === 0 || i === samples.length - 1) return true;
    const prev = samples[i - 1];
    return s.coverVisible !== prev.coverVisible || s.screenTail !== prev.screenTail;
  });
  console.log(JSON.stringify({ title, samples: keep.length, rows: keep }, null, 1));
} catch (error) {
  console.error(`FAIL: ${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  socket.close();
}
