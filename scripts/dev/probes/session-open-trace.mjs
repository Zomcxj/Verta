// Read back the DEV trace `waitForAgentUi` leaves behind, and print the tick where the cover
// lifted next to the ticks around it.
//
// Usage: node scripts/dev/probes/session-open-trace.mjs [--port=9222] [--title="<会话标题>"]
// With --title it clicks that session row first and waits for the trace to settle.
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const title =
  process.argv.find((a) => a.startsWith("--title="))?.slice(8) ?? null;
const settleMs = Number(
  process.argv.find((a) => a.startsWith("--ms="))?.slice(5) ?? "9000",
);

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
  if (title) {
    // Clear the previous trace, click the row, and give the open enough time to finish.
    await evaluate(`(() => { window.__vertaOpenTrace = []; return true; })()`);
    const clicked = await evaluate(`(() => {
      const nodes = [...document.querySelectorAll("button, [role='button'], li, div")];
      const row = nodes.find((n) => (n.textContent || "").trim().startsWith(${JSON.stringify(title)}));
      if (!row) return false;
      row.click();
      return true;
    })()`);
    if (!clicked) {
      console.error(`列表里没找到「${title}」那一行`);
      process.exit(3);
    }
    await sleep(settleMs);
  }

  const raw = await evaluate(`JSON.stringify({
    trace: window.__vertaOpenTrace ?? null,
    hook: {
      screen: typeof window.__vertaLeafScreenTail,
      alt: typeof window.__vertaLeafUsesAlternateScreen,
      bytes: typeof window.__vertaLeafOutputBytes,
    },
  })`);
  const parsed = JSON.parse(raw ?? "{}");
  if (!parsed.trace || parsed.trace.length === 0) {
    console.error(
      `没有 trace（hooks: ${JSON.stringify(parsed.hook)}）。点了会话吗？还是这一版没带 DEV 埋点？`,
    );
    process.exit(3);
  }

  // Print the exit record and the ticks leading up to it.
  const exitIndex = parsed.trace.findIndex((row) => row.exit);
  const head = parsed.trace.slice(Math.max(0, exitIndex - 4), exitIndex + 1);
  const first = parsed.trace[0];
  const last = parsed.trace[exitIndex];
  console.log(
    JSON.stringify(
      {
        ticks: parsed.trace.length,
        first: first,
        last: last,
        exit: last?.exit ?? null,
        tail: head,
      },
      null,
      1,
    ),
  );
} catch (error) {
  console.error(`FAIL: ${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  socket.close();
}
