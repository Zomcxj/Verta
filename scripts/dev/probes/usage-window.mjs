// Does the usage window show the numbers the store actually holds, and does switching scope stay
// local?
//
// The window reads every store on the machine once (this machine: ~22.6k events, ~3.4B tokens) and
// then applies the cache switches in the frontend, so there are three things that can go wrong and
// all three are checked here rather than assumed:
//
//   1. the window's numbers disagree with a direct `agent_usage_events` call;
//   2. the two day/model splits do not add up to the total (a bar chart whose parts miss);
//   3. switching a cache switch triggers a second read instead of a re-render, which would make a
//      single click cost the whole scan again.
//
// Nothing is written anywhere: the command only reads, and the window is left open.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/usage-window.mjs [--port=9222] [--range=30]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

/** A CDP connection to one page target. */
async function connect(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", (e) =>
      reject(new Error(String(e?.message ?? e))),
      { once: true },
    );
  });
  let nextId = 1;
  const pending = new Map();
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
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const what =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text;
      throw new Error(`${what} in: ${expression.slice(0, 160)}`);
    }
    return result.result.value;
  };
  const waitFor = async (expression, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(`(() => !!(${expression}))()`)) return true;
      await sleep(250);
    }
    return false;
  };
  return { socket, send, evaluate, waitFor, close: () => socket.close() };
}

const targets = async () =>
  (await fetch(`http://127.0.0.1:${port}/json`)).json();

const main = (await targets()).find(
  (t) => t.type === "page" && t.url === "http://tauri.localhost/",
);
if (!main) fail("没有主窗口的 page 目标：应用带 --remote-debugging-port 起来了吗");
const app = await connect(main.webSocketDebuggerUrl);

// Open the window the way the header button does: the same command.
const openStarted = Date.now();
await app.evaluate(`window.__TAURI_INTERNALS__.invoke("open_usage_window")`);

// It is a separate page target, and it appears only once the webview exists.
let usageTarget = null;
const openDeadline = Date.now() + 20_000;
while (Date.now() < openDeadline) {
  const found = (await targets()).find(
    (t) => t.type === "page" && t.url.includes("usage.html"),
  );
  if (found) {
    usageTarget = found;
    break;
  }
  await sleep(250);
}
if (!usageTarget) fail("usage.html 的页面目标 20 秒内没出现");
const openedInMs = Date.now() - openStarted;

const usage = await connect(usageTarget.webSocketDebuggerUrl);

// The first answer walks every store, so this is deliberately generous: on this machine the read
// is ~10 s warm and ~26 s cold, and a probe that gives up first would report "no data" for a window
// that was still working.
const painted = await usage.waitFor("window.__vertaUsage && window.__vertaUsage()", 120_000);
if (!painted) {
  const text = await usage.evaluate(
    `(document.body.innerText || "").slice(0, 400)`,
  );
  fail(`窗口 120 秒内没有画出数字，屏幕上是：${text}`);
}

const shown = JSON.parse(
  await usage.evaluate(`JSON.stringify(window.__vertaUsage())`),
);

// The same numbers straight from the command, with the same range and offset the window used.
// `sinceMs` is what the window asked for; older builds of the hook expose only `range`, so the same
// value is recomputed from it (the two differ by the seconds between the window's load and this
// line, which cannot move a token between days).
const sinceMs =
  shown.sinceMs === undefined
    ? shown.range === 0
      ? null
      : Date.now() - shown.range * 24 * 60 * 60 * 1000
    : shown.sinceMs;
const direct = JSON.parse(
  await usage.evaluate(`(async () => {
    const answer = await window.__TAURI_INTERNALS__.invoke("agent_usage_events", {
      sinceMs: ${sinceMs === null ? "null" : sinceMs},
      offsetMinutes: new Date().getTimezoneOffset() * -1,
      cacheRead: true,
      cacheWrite: true,
    });
    return JSON.stringify({
      tokens: answer.tokens,
      events: answer.events,
      days: answer.days.length,
      models: answer.models.length,
      failures: answer.failures,
      scope: answer.scope,
    });
  })()`),
);

// What the DOM itself says, which is what a person reads: the rows are the drawing of the answer.
const dom = JSON.parse(
  await usage.evaluate(`(() => {
    const dayRows = [...document.querySelectorAll("[data-usage-day-tokens]")];
    const modelRows = [...document.querySelectorAll("[data-usage-model-tokens]")];
    const head = document.querySelector("main .tabular-nums");
    return JSON.stringify({
      dayRows: dayRows.length,
      modelRows: modelRows.length,
      daySum: dayRows.reduce((sum, el) => sum + Number(el.getAttribute("data-usage-day-tokens")), 0),
      modelSum: modelRows.reduce((sum, el) => sum + Number(el.getAttribute("data-usage-model-tokens")), 0),
      totalText: (head?.textContent || "").trim(),
      firstDayLabel: (dayRows[0]?.parentElement?.innerText || "").trim().slice(0, 40),
      firstModel: (modelRows[0]?.parentElement?.innerText || "").trim().slice(0, 60),
      text: (document.body.innerText || "").slice(0, 300),
    });
  })()`),
);

const report = { openedInMs, shown, direct, dom };
const problems = [];

if (shown.tokens !== shown.rustTokens) {
  problems.push(
    `前端算出的总数 ${shown.tokens} 与 Rust 算的 ${shown.rustTokens} 不一致`,
  );
}
if (direct.tokens !== shown.rustTokens) {
  problems.push(
    `窗口的总数 ${shown.rustTokens} 与直接调用命令的 ${direct.tokens} 不一致`,
  );
}
if (dom.daySum !== shown.tokens) {
  problems.push(`按天各行之和 ${dom.daySum} != 总计 ${shown.tokens}`);
}
if (dom.modelSum !== shown.tokens) {
  problems.push(`按模型各行之和 ${dom.modelSum} != 总计 ${shown.tokens}`);
}
if (dom.dayRows !== shown.days) {
  problems.push(`按天画了 ${dom.dayRows} 行，报告里是 ${shown.days} 天`);
}
if (dom.modelRows !== shown.models) {
  problems.push(`按模型画了 ${dom.modelRows} 行，报告里是 ${shown.models} 个`);
}
if (shown.failures.length > 0) {
  problems.push(`有存储读不出来：${shown.failures.join(" / ")}`);
}

// Switching a switch must be a re-render. The read it would otherwise repeat is the whole scan, so
// "did it finish quickly" is the observable difference, and it is checked on the clock.
const switchStart = Date.now();
await usage.evaluate(`(() => {
  const switches = [...document.querySelectorAll("[role=switch]")];
  switches[0]?.click();
  return switches.length;
})()`);
const toggled = await usage.waitFor(
  `window.__vertaUsage().scope.cacheRead === false`,
  5_000,
);
const toggleMs = Date.now() - switchStart;
const afterToggle = JSON.parse(
  await usage.evaluate(`JSON.stringify(window.__vertaUsage())`),
);
report.toggle = { ms: toggleMs, painted: toggled, after: afterToggle };

if (!toggled) problems.push("关掉「含缓存读」后 5 秒内没有重画");
if (toggled) {
  // With cache reads on, nothing was excluded, so the drop must be exactly the cache-read part.
  const cacheReadPart = afterToggle.excludedCacheRead;
  if (afterToggle.tokens + cacheReadPart !== shown.tokens) {
    problems.push(
      `关缓存读后 ${afterToggle.tokens} + 缓存读 ${cacheReadPart} != 原来的 ${shown.tokens}`,
    );
  } else if (cacheReadPart === 0) {
    problems.push("这个范围内没有缓存读 token，切开关这件事没被真正验证到");
  }
  if (toggleMs > 1_500) {
    problems.push(`切开关用了 ${toggleMs}ms，像是在重新读盘而不是重画`);
  }
}

// And back, because a switch that only works in one direction is still broken.
await usage.evaluate(`(() => {
  const switches = [...document.querySelectorAll("[role=switch]")];
  switches[0]?.click();
  return true;
})()`);
const restored = await usage.waitFor(
  `window.__vertaUsage().tokens === ${shown.rustTokens}`,
  5_000,
);
if (!restored) problems.push("把「含缓存读」开回来，总数没有回到原来的值");

console.log(JSON.stringify(report, null, 2));
app.close();
usage.close();

if (problems.length > 0) {
  console.log("\nFAILED:");
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log("\nOK: 数字一致，两个分组之和都等于总计，切开关是重画");
}
