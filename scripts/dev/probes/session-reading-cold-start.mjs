// What the sessions panel says during a cold start, sampled from the first frame it can be seen.
//
// The claim under test is about words on screen: while the first read of the session stores is still
// running, the panel must not report an empty list. A distro is read by running a query inside it, so
// its answer arrives seconds after this machine's, and the list is outstanding for a while even when
// it is about to have rows. "没有会话记录" during that window is a claim nobody has checked, and it is
// what the panel used to show.
//
// The state is sampled inside the page rather than polled from here: an interval in the page can see a
// state that lasts a frame, while a round trip over CDP cannot. The sampler is installed through
// addScriptToEvaluateOnNewDocument, so it is in place before any page script runs, and the same
// source is evaluated immediately too in case the attach happened after the document started; the
// report says which of the two covered the run.
//
// Two surfaces can say "reading" and they are not the same thing. The list draws 读取中 in its own
// empty state, which by definition only exists while the list is empty, so it can only cover the
// wait when this machine has nothing to show either. The panel's header draws it on the refresh
// button for as long as the first read is in flight, which is the whole wait. The report measures
// both and says which one covered the distro's block arriving.
//
// The reads themselves are read through the channel they actually use, and the drawn result is read
// off the DOM. `session-cold-start.mjs` tried to hook `window.__TAURI_INTERNALS__.invoke` and
// reported no reads at all on every run: that property is an own, non-writable, non-configurable one
// (`Object.getOwnPropertyDescriptor` says so, and 601 retries left it unchanged), so the assignment
// is silently dropped. The IPC is a `fetch` to the `ipc.localhost` scheme instead, which is writable,
// and the arguments are the request body.
//
// It does not change what is on screen: the only thing it asks the page to do is reload (with
// `--reload`) or nothing at all (without it, for a run where the application was just started).
//
// Usage (dev instance with --remote-debugging-port=9222 and the WSL toggle on):
//   node scripts/dev/probes/session-reading-cold-start.mjs --reload
//   node scripts/dev/probes/session-reading-cold-start.mjs --wait=90000 --observe=25000
//
// Reads the WSL toggle and the sidebar view out of the page, and says so in the report when either is
// not what a cold start needs, rather than measuring something else and calling it a pass.
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const waitMs = Number(arg("wait", "90000"));
const observeMs = Number(arg("observe", "25000"));
const reload = process.argv.includes("--reload");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Installed before the page boots. Records what the empty state says, how many rows are drawn and
 * which source blocks are on screen, every 25 ms.
 *
 * `performance.now()` is the clock, so the offsets in the report are from the document's own start.
 */
const INSTRUMENT = `
(() => {
  if (window.__readingProbe) return;
  const probe = {
    installedAt: Math.round(performance.now()),
    readyStateAtInstall: document.readyState,
    samples: [],
  };
  window.__readingProbe = probe;
  // The source headings are the only thing on screen that says which store a block came from. They
  // are drawn only when more than one source is present, and the rows under one are its own.
  const HEADING = 'div[class*="font-medium"][class*="text-[10px]"]';
  // The panel's own header, found by its title: the manage/done button and the refresh button live
  // there, and whose the second of the two is.
  const headerButtons = () => {
    const title = [...document.querySelectorAll("span")].find((span) =>
      /^(会话|Sessions)$/.test((span.textContent || "").trim()),
    );
    const header = title ? title.parentElement : null;
    return header
      ? [...header.querySelectorAll("button")].map((b) => (b.textContent || "").trim())
      : [];
  };
  const sample = () => {
    const empty = document.querySelector("[data-session-empty]");
    const sources = [...document.querySelectorAll(HEADING)].map((heading) => ({
      label: (heading.textContent || "").trim(),
      rows: heading.parentElement
        ? heading.parentElement.querySelectorAll("[data-session-id]").length
        : 0,
    }));
    probe.samples.push({
      at: Math.round(performance.now()),
      empty: empty ? empty.getAttribute("data-session-empty") : null,
      text: empty ? (empty.textContent || "").trim() : null,
      rows: document.querySelectorAll("[data-session-id]").length,
      sources,
      header: headerButtons(),
    });
  };
  sample();
  probe.timer = setInterval(sample, 25);
  // The reads themselves, through the channel they actually use. The internal invoke() is an own,
  // non-writable, non-configurable property, so wrapping it is silently dropped; the IPC is a fetch
  // to the IPC scheme, and that one is writable. The command's arguments are the request body, so
  // each read is reported with the tool and distro it asked about.
  probe.reads = [];
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    const match = /agent_sessions_list|wsl_list_distros/.exec(url);
    if (!match) return originalFetch.apply(this, arguments);
    let args = null;
    try {
      args = init && typeof init.body === "string" ? JSON.parse(init.body) : null;
    } catch {}
    const entry = {
      at: Math.round(performance.now()),
      cmd: match[0],
      tool: (args && args.tool) || null,
      distro: (args && args.distro) || null,
      settled: null,
    };
    probe.reads.push(entry);
    return originalFetch.apply(this, arguments).then(
      (value) => {
        entry.settled = Math.round(performance.now());
        return value;
      },
      (error) => {
        entry.settled = Math.round(performance.now());
        entry.failed = String(error && error.message ? error.message : error);
        throw error;
      },
    );
  };
})();
`;

// The page target for the main window. The settings window is a second page target, so the URL is
// matched rather than "the first page".
const MAIN_URL = /(localhost:1420|tauri\.localhost)\/?$/;

async function findTarget(deadline) {
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
      const page = targets.find((t) => t.type === "page" && MAIN_URL.test(t.url));
      if (page) return page;
    } catch {
      // The endpoint is not up yet: the application has not started its webview.
    }
    await sleep(50);
  }
  return null;
}

const target = await findTarget(Date.now() + waitMs);
if (!target) {
  console.error(`等了 ${waitMs}ms 也没有主窗口的 page 目标（9222）`);
  process.exit(1);
}

const socket = new WebSocket(target.webSocketDebuggerUrl);
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

const report = { reload, waitedForApp: !reload, waitMs, observeMs };
try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });
  // Also in the document that is already up, for a run that attached after it started. The report
  // says which of the two covered the run.
  report.installedInCurrentDocument = await pageEval(
    `${INSTRUMENT}\nreturn Boolean(window.__readingProbe);`,
  );

  if (reload) await send("Page.reload", { ignoreCache: false });
  await sleep(observeMs);

  // Read at the end, not on attach: on a cold start the attach lands on the document the webview
  // starts with, and a module specifier cannot be resolved from there. By now the run is over and
  // these are the settings it ran under.
  const raw = await pageEval(`
    const probe = window.__readingProbe;
    if (!probe) return null;
    if (probe.timer) clearInterval(probe.timer);
    probe.timer = null;
    // The app's own module instances, found through the resource entries: a fresh import of the
    // bare specifier gives a second copy of the store, with default values in it.
    const urls = performance.getEntriesByType("resource").map((e) => e.name);
    const find = (path) => {
      const hits = urls.filter((n) => n.includes(path));
      return hits.find((n) => n.includes("?t=")) ?? hits[0] ?? ("/src/" + path);
    };
    const mod = await import(find("modules/settings/preferences.ts"));
    const state = mod.usePreferencesStore.getState();
    return JSON.stringify({
      installedAt: probe.installedAt,
      readyStateAtInstall: probe.readyStateAtInstall,
      samples: probe.samples,
      reads: probe.reads,
      settings: {
        wslEnabled: state.wslEnabled,
        hydrated: state.hydrated,
        sidebarView: window.localStorage.getItem("verta.sidebar.view"),
        language: state.language,
      },
    });
  `);
  if (raw === null) {
    throw new Error("页面里没有采样器：这次运行什么都没测到");
  }
  const measured = JSON.parse(raw);
  report.settings = measured.settings;
  report.installedAt = measured.installedAt;
  report.readyStateAtInstall = measured.readyStateAtInstall;
  report.sampleCount = measured.samples.length;
  report.reads = measured.reads ?? [];
  const samples = measured.samples;
  const at = (sample) => sample.at;

  // Only the frames where something changed: a 25 ms sampler over 25 s is a thousand identical rows.
  const changes = [];
  let previous = null;
  for (const sample of samples) {
    const key = JSON.stringify([sample.empty, sample.rows, sample.sources, sample.header]);
    if (key !== previous) {
      changes.push(sample);
      previous = key;
    }
  }
  report.changes = changes;
  report.first = samples[0] ?? null;
  report.last = samples[samples.length - 1] ?? null;

  const reading = samples.filter((s) => s.empty === "reading");
  report.readingSpanMs =
    reading.length > 0 ? { from: at(reading[0]), to: at(reading[reading.length - 1]) } : null;
  report.readingFrames = reading.length;

  // The header's own reading state: the refresh button says it is reading for as long as the first
  // read is in flight, which is the whole wait rather than only the frames the list is empty in.
  const headerReading = samples.filter((s) => s.header.includes("读取中") || s.header.includes("Reading"));
  report.headerReadingSpanMs =
    headerReading.length > 0
      ? { from: at(headerReading[0]), to: at(headerReading[headerReading.length - 1]) }
      : null;
  report.headerFrames = headerReading.length;
  report.headerLabels = [...new Set(samples.flatMap((s) => s.header))];

  // The frames the list was empty, and what it said in them: nothing drawn yet (the panel is behind
  // the lazy boundary), or "reading". "empty" here is the bug.
  const emptyList = samples.filter((s) => s.rows === 0);
  report.emptyListStates = [...new Set(emptyList.map((s) => s.empty))];
  report.panelFirstDrawnAt = samples.find((s) => s.empty !== null || s.rows > 0)?.at ?? null;

  const firstRow = samples.find((s) => s.rows > 0);
  report.firstRowAt = firstRow ? at(firstRow) : null;
  report.firstRowCount = firstRow ? firstRow.rows : null;

  const wsl = samples.find((s) => s.sources.some((source) => /^WSL/.test(source.label)));
  report.firstWslBlockAt = wsl ? at(wsl) : null;
  report.wslRowsAtEnd =
    samples[samples.length - 1]?.sources.find((source) => /^WSL/.test(source.label))?.rows ?? 0;
  report.localRowsAtEnd =
    samples[samples.length - 1]?.sources.find((source) => /^本机|^This machine/.test(source.label))
      ?.rows ?? null;
  report.rowCountOverTime = [...new Set(samples.map((s) => s.rows))];

  // Which reads were still outstanding, so the frames are read against what they were waiting for
  // rather than taken on faith.
  const outstandingAt = (time) =>
    report.reads.filter((r) => r.settled === null || r.settled > time);
  report.readDurationMs = report.reads.map((r) => ({
    tool: r.tool,
    distro: r.distro,
    at: r.at,
    ms: r.settled === null ? null : r.settled - r.at,
    ...(r.failed ? { failed: r.failed } : {}),
  }));
  report.outstandingWhileListEmpty = changes
    .filter((s) => s.rows === 0)
    .map((s) => ({ at: s.at, empty: s.empty, outstanding: outstandingAt(s.at).length }));
  report.outstandingAtLastFrame = outstandingAt(samples[samples.length - 1]?.at ?? 0).length;

  // The question the queue asks is whether the distro's wait is visible at all. Two surfaces can
  // say so, and they answer differently: the header's refresh button for as long as the first read
  // is in flight, and the list's own empty state, which only exists while the list is empty.
  if (report.headerReadingSpanMs && report.firstWslBlockAt !== null) {
    report.headerCoversDistroWait =
      report.headerReadingSpanMs.to >= report.firstRowAt && report.headerReadingSpanMs.from <= report.firstWslBlockAt;
  } else {
    report.headerCoversDistroWait = false;
  }
  report.listReadingCoversDistroWait =
    report.readingSpanMs !== null && report.readingSpanMs.to > report.firstWslBlockAt;

  // A claim of emptiness while a source is still out: the panel drew its empty state, which happens
  // only while it counts as reading, and reading means an answer has not arrived. Reported with the
  // frames around it so it can be read rather than trusted.
  report.emptyClaimFrames = samples
    .map((s, index) => ({ sample: s, index }))
    .filter(({ sample }) => sample.empty === "empty")
    .slice(0, 8)
    .map(({ sample, index }) => ({
      at: sample.at,
      text: sample.text,
      rows: sample.rows,
      before: samples[index - 1]?.empty ?? null,
      after: samples[index + 1]?.empty ?? null,
    }));

  console.log(JSON.stringify(report, null, 1));

  const problems = [];
  if (report.settings.wslEnabled !== true) problems.push("WSL 开关没打开");
  if (report.settings.sidebarView !== "launcher") problems.push("侧栏不在会话列表上");
  if (report.firstWslBlockAt === null) problems.push("这次运行里没有出现 WSL 的会话块");
  if (report.readingSpanMs === null) problems.push("空列表时没出现过「读取中」");
  if (report.emptyClaimFrames.length > 0)
    problems.push("列表空着的时候报了「没有会话记录」");
  if (report.reads.length === 0) problems.push("没记到任何会话读取");
  if (!report.outstandingWhileListEmpty.some((f) => f.outstanding > 0))
    problems.push("「读取中」没有对应的未完成读取");
  if (report.outstandingAtLastFrame > 0)
    problems.push(`最后一帧还有 ${report.outstandingAtLastFrame} 个读取没回来，看得太短`);
  if (problems.length > 0) {
    console.error(`\n没有通过：${problems.join("；")}`);
    process.exit(1);
  }
  console.log(
    "\n通过：冷启动里有 WSL 读取；列表空着的那几帧说的是「读取中」而不是「没有会话记录」；" +
      `等待 WSL 期间顶栏的刷新按钮${report.headerCoversDistroWait ? "一直" : "没有"}说「读取中」` +
      `（列表自己的读取中${report.listReadingCoversDistroWait ? "一直" : "没有"}盖到 WSL 的行出现）。`,
  );
} catch (error) {
  report.error = String(error?.message ?? error);
  console.log(JSON.stringify(report, null, 1));
  process.exit(1);
} finally {
  socket.close();
}
