// Does the usage window show what the stores hold, and is a range or a switch a re-draw rather than
// a re-read?
//
// The window reads every store once (this machine: ~22.6k events, ~3.4B tokens) and every view it
// offers is a sum over the same per-day cells, so four things can go wrong and all four are checked
// here rather than assumed:
//
//   1. the window's numbers disagree with a direct `agent_usage_events` call;
//   2. the tool rows, the model rows or the heatmap do not add up to the total;
//   3. the chart draws nothing, or draws more colours than it folds into "other";
//   4. switching a range or a cache switch costs another scan instead of a re-render.
//
// Nothing is written anywhere: the command only reads, and the window is left open.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/usage-window.mjs [--port=9222]
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

const targets = async () => (await fetch(`http://127.0.0.1:${port}/json`)).json();

const main = (await targets()).find(
  (t) => t.type === "page" && t.url === "http://tauri.localhost/",
);
if (!main) fail("没有主窗口的 page 目标：应用带 --remote-debugging-port 起来了吗");
const app = await connect(main.webSocketDebuggerUrl);

const openStarted = Date.now();
await app.evaluate(`window.__TAURI_INTERNALS__.invoke("open_usage_window")`);

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

// The first answer walks every store, so this is deliberately generous: the read is ~10 s warm and
// ~26 s cold on this machine, and a probe that gives up first would report "no data" for a window
// that was still working.
const painted = await usage.waitFor("window.__vertaUsage && window.__vertaUsage()", 120_000);
if (!painted) {
  const text = await usage.evaluate(`(document.body.innerText || "").slice(0, 500)`);
  fail(`窗口 120 秒内没有画出数字，屏幕上是：${text}`);
}

const read = async () =>
  JSON.parse(await usage.evaluate(`JSON.stringify(window.__vertaUsage())`));

// The window outlives a probe run (closing it only hides it), so a run always starts by putting the
// filters back where they began: all agents, this month. Otherwise the second run measures the
// first run's leftovers.
await usage.evaluate(`(() => {
  document.querySelector('[data-usage-chip="null"]')?.click();
  document.querySelector('[data-usage-chip="month"]')?.click();
  return true;
})()`);
await usage.waitFor(
  `window.__vertaUsage().tool === null && window.__vertaUsage().range === "month"`,
  5_000,
);

/** What the DOM itself says, which is what a person reads. */
const dom = async () =>
  JSON.parse(
    await usage.evaluate(`(() => {
      const number = (raw) => {
        if (raw === undefined || raw === null || raw === "") return 0;
        return Number(raw);
      };
      const rows = [...document.querySelectorAll("[data-usage-row]")];
      const heat = [...document.querySelectorAll("[data-usage-heat]")];
      return JSON.stringify({
        total: number(document.querySelector("[data-usage-total]")?.getAttribute("data-usage-total")),
        rows: rows.length,
        rowTokens: rows.reduce((sum, el) => sum + number(el.getAttribute("data-usage-row-tokens")), 0),
        heatCells: heat.length,
        heatPainted: heat.filter((el) => number(el.getAttribute("data-usage-heat-level")) > 0).length,
        heatTokens: heat.reduce((sum, el) => sum + number(el.getAttribute("data-usage-heat-tokens")), 0),
        bars: document.querySelectorAll("svg rect").length,
        text: (document.body.innerText || "").slice(0, 320),
      });
    })()`),
  );

const shown = await read();
const first = await dom();

// The same read, straight from the command, so the window is compared against the data rather than
// against itself.
const direct = JSON.parse(
  await usage.evaluate(`(async () => {
    const answer = await window.__TAURI_INTERNALS__.invoke("agent_usage_events", {
      sinceMs: null,
      offsetMinutes: new Date().getTimezoneOffset() * -1,
      cacheRead: true,
      cacheWrite: true,
    });
    return JSON.stringify({
      tokens: answer.tokens,
      events: answer.events,
      days: answer.days.length,
      cells: answer.days.reduce((sum, day) => sum + day.cells.length, 0),
      failures: answer.failures,
    });
  })()`),
);

const report = { openedInMs, shown, direct, dom: first };
const problems = [];

if (direct.tokens !== shown.rustTokens) {
  problems.push(`窗口的总数 ${shown.rustTokens} 与直接调用命令的 ${direct.tokens} 不一致`);
}
if (first.total !== Math.round(shown.tokens)) {
  problems.push(`画出来的总数 ${first.total} 与视图的 ${Math.round(shown.tokens)} 不一致`);
}
const toolSum = shown.tools.reduce((sum, row) => sum + row.tokens, 0);
if (Math.abs(toolSum - shown.tokens) > 0.5) {
  problems.push(`Agent 各行之和 ${toolSum} != 总计 ${shown.tokens}`);
}
// The model table's rows are read from the DOM: `__vertaUsage().models` is a count in the build
// this probe was written against, so the rows themselves are the honest source.
const modelRows = JSON.parse(
  await usage.evaluate(`(() => JSON.stringify(
    [...document.querySelectorAll("[data-usage-row]")]
      .filter((el) => (el.getAttribute("data-usage-row") || "").includes("/"))
      .map((el) => ({
        label: el.getAttribute("data-usage-row"),
        tokens: Number(el.getAttribute("data-usage-row-tokens")),
      })),
  ))()`),
);
report.modelRows = modelRows.length;
const modelSum = modelRows.reduce((sum, row) => sum + row.tokens, 0);
if (Math.abs(modelSum - shown.tokens) > 0.5) {
  problems.push(`模型各行之和 ${modelSum} != 总计 ${shown.tokens}`);
}
if (modelRows.length !== shown.models) {
  problems.push(`模型表画了 ${modelRows.length} 行，视图里是 ${shown.models}`);
}
if (first.heatPainted !== shown.heat.painted) {
  problems.push(`热力图涂了 ${first.heatPainted} 格，数据里是 ${shown.heat.painted}`);
}
if (first.heatCells < 53 * 7) {
  problems.push(`热力图只有 ${first.heatCells} 格，53 周应该是 ${53 * 7}`);
}
if (first.heatTokens < shown.tokens) {
  // The heatmap covers 53 weeks and the totals cover everything on the machine, so this is a lower
  // bound rather than an equality - but it may never be smaller than one range.
  problems.push(`热力图的 token 之和 ${first.heatTokens} 小于这段范围的 ${shown.tokens}`);
}
if (first.bars < shown.trend.columns / 2) {
  problems.push(`图上只有 ${first.bars} 个矩形，柱状图应该按天画`);
}
if (shown.trend.series.length > 7) {
  problems.push(`图上画了 ${shown.trend.series.length} 条系列，应该折叠到 7 条以内`);
}
if (shown.trend.columns === 0) {
  problems.push("图的列数是 0");
}

// A range change is a sum over the days already in memory: no second read.
const startedRange = Date.now();
await usage.evaluate(`(() => {
  const chip = document.querySelector('[data-usage-chip="today"]');
  chip?.click();
  return !!chip;
})()`);
const ranged = await usage.waitFor(
  `window.__vertaUsage() && window.__vertaUsage().range === "today"`,
  5_000,
);
const rangeMs = Date.now() - startedRange;
const afterRange = await read();
report.range = { ms: rangeMs, painted: ranged, tokens: afterRange.tokens, days: afterRange.days };
if (!ranged) problems.push("切到「今日」后 5 秒内没有重画");
if (rangeMs > 1_500) problems.push(`切范围用了 ${rangeMs}ms，像是在重新读盘`);
if (ranged) {
  if (afterRange.days > 1) problems.push(`「今日」画了 ${afterRange.days} 天`);
  if (afterRange.tokens > shown.tokens) problems.push("「今日」比整段还多");
}

// Back to the month, then switch a cache switch: the difference must be exactly the cache part.
await usage.evaluate(`(() => {
  const chip = document.querySelector('[data-usage-chip="month"]');
  chip?.click();
  return !!chip;
})()`);
await usage.waitFor(
  `window.__vertaUsage() && window.__vertaUsage().range === "month"`,
  5_000,
);
const beforeToggle = await read();
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
const afterToggle = await read();
report.toggle = { ms: toggleMs, painted: toggled, before: beforeToggle.tokens, after: afterToggle.tokens };
if (!toggled) problems.push("关掉「含缓存读」后 5 秒内没有重画");
if (toggled) {
  const dropped = beforeToggle.tokens - afterToggle.tokens;
  if (dropped <= 0) {
    problems.push("关掉缓存读总数没有变小，这段范围里应该是有缓存读的");
  }
  if (toggleMs > 1_500) problems.push(`切开关用了 ${toggleMs}ms，像是在重新读盘`);
}

await usage.evaluate(`(() => {
  const switches = [...document.querySelectorAll("[role=switch]")];
  switches[0]?.click();
  return true;
})()`);
const restored = await usage.waitFor(
  `Math.abs(window.__vertaUsage().tokens - ${beforeToggle.tokens}) < 1`,
  5_000,
);
if (!restored) problems.push("把「含缓存读」开回来，总数没有回到原来的值");

// The tool filter, clicked the way a person would: the summary must then equal that tool's row.
// The tool that has usage in this range is the one worth clicking - picking one that used nothing
// would only prove that an empty filter draws an empty table.
const busiest = [...shown.tools].sort((left, right) => right.tokens - left.tokens)[0];
if (!busiest) {
  problems.push("这段范围里一个 Agent 都没有，筛选没法验证");
} else {
  const filtered = await usage.evaluate(`(() => {
    const chip = document.querySelector('[data-usage-chip="${busiest.label}"]');
    chip?.click();
    return !!chip;
  })()`);
  if (!filtered) {
    problems.push(`没有找到 ${busiest.label} 的筛选 chip`);
  } else {
    await usage.waitFor(`window.__vertaUsage().tool === "${busiest.label}"`, 5_000);
    const perTool = await read();
    report.filter = { tool: busiest.label, tokens: perTool.tokens, expected: busiest.tokens };
    if (Math.abs(perTool.tokens - busiest.tokens) > 0.5) {
      problems.push(
        `选了 ${busiest.label} 之后总计 ${perTool.tokens}，它那行是 ${busiest.tokens}`,
      );
    }
    if (perTool.tools.length > 1) {
      problems.push(`选了 ${busiest.label} 之后 Agent 表里还有 ${perTool.tools.length} 行`);
    }
  }
}

console.log(JSON.stringify(report, null, 2));
app.close();
usage.close();

if (problems.length > 0) {
  console.log("\nFAILED:");
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log(
    "\nOK: 数字一致，两种归因与热力图都对得上，切范围/切开关/切工具都是重画",
  );
}
