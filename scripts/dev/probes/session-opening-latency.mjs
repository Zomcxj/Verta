// How long does the session-opening cover actually stay up, and what was on screen when it lifted?
//
// The complaint: every so often the transition layer lingers a moment longer than it should before
// the terminal appears ("会话加载过渡层末尾偶尔多停一会儿才进入"). The cover lifts when the agent's own
// screen has been painted (`waitForAgentUi`), its last resort is a 45 s timer, and until now nothing
// recorded which of those happened or how long it took on a release build - so "occasionally a
// moment longer" could be one missed frame or a wait that ran to its cap, with no way to tell.
//
// This is a measurement, not a verdict on the rule: it opens a session, samples the layer's
// presence in the DOM while the app's own record (`sessionOpenings` in `terminalDebugStats`) holds
// the duration, the lift reason, the ticks the wait ran and the leaf's screen at that instant. Two
// independent clocks have to agree, or one of them is wrong and the numbers mean nothing.
//
// Nothing is typed: the session is resumed and left alone, its tab is closed again and the agent
// process this run started is ended. The list itself is not modified.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/session-opening-latency.mjs [--port=9222] [--tool=opencode] [--runs=3]
import { execFileSync } from "node:child_process";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const tool =
  process.argv.find((a) => a.startsWith("--tool="))?.slice(7) ?? "opencode";
const runs = Number(
  process.argv.find((a) => a.startsWith("--runs="))?.slice(7) ?? "3",
);
/** How much the DOM sampler may differ from the app's own clock before the two disagree. */
const TOLERANCE_MS = 700;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { tool, runs: [], windows: [] };
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page =
  targets.find((t) => t.type === "page" && t.url === "http://tauri.localhost/") ??
  targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
if (!page) fail("没有主窗口的 page 目标：应用带 --remote-debugging-port 起来了吗");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve);
  socket.addEventListener("error", (e) =>
    reject(new Error(String(e?.message ?? e))),
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
const waitFor = async (expression, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`(() => !!(${expression}))()`)) return true;
    await sleep(200);
  }
  return false;
};

/** Processes resuming this session, by executable as well as command line. */
const resumeProcesses = (id) => {
  const command = `(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('claude.exe','node.exe','pi.exe','opencode.exe') -and $_.CommandLine -like '*${id}*' } | ForEach-Object { "$($_.ProcessId)" }) -join " "`;
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    })
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter(Number.isFinite);
  } catch {
    return [];
  }
};

const tabIds = () =>
  evaluate(
    `JSON.stringify([...document.querySelectorAll("[data-tab-id]")].map((el) => el.getAttribute("data-tab-id")))`,
  ).then((raw) => JSON.parse(raw));

const openTitles = () =>
  evaluate(
    `JSON.stringify([...document.querySelectorAll("[data-tab-id]")].map((el) => (el.innerText || "").trim()))`,
  ).then((raw) => JSON.parse(raw));

const openings = () =>
  evaluate(
    `(() => {
      const stats = window.__vertaTerm;
      if (typeof stats !== "function") return JSON.stringify({ error: "no-diagnostics" });
      return JSON.stringify(stats().sessionOpenings ?? []);
    })()`,
  ).then((raw) => JSON.parse(raw));

let started = [];
try {
  await send("Page.bringToFront");
  await sleep(400);

  // The record lives in the app's own diagnostics, which a release build installs only for a window
  // that asked for them (`terminalDiagnosticsEnabled`). Asking means setting the flag and reloading
  // once: every sample below then comes from the release build the report is about.
  if (!(await evaluate(`typeof window.__vertaTerm === "function"`))) {
    report.windows.push("diagnostics: flag set, reloading");
    await evaluate(
      `(() => { try { localStorage.setItem("verta:terminal-diagnostics", "1"); return true; } catch { return false; } })()`,
    );
    await send("Page.reload", { ignoreCache: false });
    await sleep(6000);
  }
  if (!(await waitFor(`typeof window.__vertaTerm === "function"`, 40000))) {
    fail("__vertaTerm 没装起来（localStorage verta:terminal-diagnostics=1 后仍有问题）");
  }
  report.windows.push("diagnostics: on");

  // The list has to be on screen for a row to be pressed.
  if (!(await evaluate(`document.querySelectorAll("[data-session-id]").length > 0`))) {
    const pressed = await evaluate(
      `(() => {
        const rail = [...document.querySelectorAll("button")].find((b) => /^(会话|Sessions)$/.test((b.getAttribute("aria-label") || "").trim()));
        if (!rail) return false;
        rail.click();
        return true;
      })()`,
    );
    if (!pressed) fail("找不到打开会话列表的按钮");
    await sleep(1500);
  }

  const listed = JSON.parse(
    await evaluate(
      `window.__TAURI_INTERNALS__.invoke("agent_sessions_list", { tool: ${JSON.stringify(tool)}, distro: null }).then((p) => JSON.stringify(p.sessions.map((s) => ({ id: s.id, title: s.title })))).catch((error) => JSON.stringify({ error: String(error) }))`,
    ),
  );
  if (listed.error) fail(`agent_sessions_list(${tool}) 失败: ${listed.error}`);
  report.sessions = listed.length;

  for (let run = 1; run <= runs; run += 1) {
    const open = await openTitles();
    const candidate = listed.find((s) => !open.includes(s.title));
    if (!candidate) {
      fail(`列表里每个 ${tool} 会话都已经是标签了（${open.join(", ")}），没有可开的那一个`);
    }
    const row = `document.querySelector('[data-session-id=${JSON.stringify(candidate.id)}]')`;
    if (!(await waitFor(row, 20000))) {
      fail(`列表里没有 ${candidate.id} 这一行（${candidate.title}）`);
    }

    const beforeSeq = (await openings()).at(-1)?.seq ?? 0;
    const beforeTabs = await tabIds();
    const beforeLeaves = JSON.parse(
      await evaluate(
        `JSON.stringify(window.__vertaTerm().ghosttySessions.map((s) => s.leafId))`,
      ),
    );
    const pidsBefore = resumeProcesses(candidate.id);

    // Sampled from before the press, in the page, with its own clock: the layer's appearance and
    // disappearance are only observable here, and the app's record is the second opinion.
    await evaluate(`(() => {
      if (window.__openingProbe?.timer) clearInterval(window.__openingProbe.timer);
      window.__openingProbe = { samples: [] };
      const tick = () => {
        window.__openingProbe.samples.push({
          at: Date.now(),
          up: !!document.querySelector("[data-session-opening]"),
        });
      };
      tick();
      window.__openingProbe.timer = setInterval(tick, 40);
      return "installed";
    })()`);
    const pressedAt = Date.now();
    await evaluate(
      `(() => { const el = ${row}; el.scrollIntoView({ block: "center" }); el.click(); return true; })()`,
    );

    // Until the sampler has seen the layer up and then down again. The cap is the app's own fallback
    // plus a margin, because a run that only ends there is exactly the number this probe records.
    const readSamples = () =>
      evaluate(`JSON.stringify(window.__openingProbe.samples)`).then((raw) =>
        JSON.parse(raw),
      );
    const seenUp = () =>
      evaluate(`window.__openingProbe.samples.some((s) => s.up)`);
    const deadline = Date.now() + 60_000;
    let gone = false;
    let appeared = false;
    let leafId = null;
    /** From the press to the first moment the pane had anything on it at all. */
    let firstContentMs = null;
    while (Date.now() < deadline) {
      const samples = await readSamples();
      const lastUp = samples.map((s) => s.up).lastIndexOf(true);
      appeared ||= lastUp >= 0;
      // Which leaf this opening is showing: a tab that was not there before is the only new one.
      if (leafId === null) {
        const leaves = JSON.parse(
          await evaluate(
            `JSON.stringify(window.__vertaTerm().ghosttySessions.map((s) => s.leafId))`,
          ),
        );
        leafId = leaves.find((id) => !beforeLeaves.includes(id)) ?? null;
      }
      if (leafId !== null && firstContentMs === null) {
        const tail = await evaluate(
          `(() => { const t = window.__vertaTerm().screenTail(${leafId}); return t === null ? null : t; })()`,
        );
        if (typeof tail === "string" && tail.trim().length > 0) {
          firstContentMs = Date.now() - pressedAt;
        }
      }
      if (lastUp >= 0 && samples.slice(lastUp + 1).some((s) => !s.up)) {
        gone = true;
        break;
      }
      await sleep(80);
    }
    // Stopped before the final read, so the samples are the run's and nothing else's.
    const samples = JSON.parse(
      await evaluate(
        `(clearInterval(window.__openingProbe.timer), JSON.stringify(window.__openingProbe.samples))`,
      ),
    );
    await evaluate(`(() => { delete window.__openingProbe; return true; })()`);
    if (!appeared && !(await seenUp())) {
      fail(`第 ${run} 次：过渡层没出现（${candidate.title}）`);
    }
    if (!gone) {
      fail(
        `第 ${run} 次：60 秒内过渡层没收起（${candidate.title}），最后的屏幕是 ${JSON.stringify(samples.at(-1))}`,
      );
    }

    const firstUp = samples.find((s) => s.up)?.at ?? null;
    const lastUpIndex = samples.map((s) => s.up).lastIndexOf(true);
    const goneAt =
      samples.slice(lastUpIndex + 1).find((s) => !s.up)?.at ?? null;
    const domMs = firstUp !== null && goneAt !== null ? goneAt - firstUp : null;

    // The app's own record of that opening, matched by sequence rather than by timing.
    let record = null;
    for (let attempt = 0; attempt < 20 && record === null; attempt += 1) {
      record = (await openings()).find((r) => r.seq > beforeSeq) ?? null;
      if (record === null) await sleep(250);
    }
    if (record === null) {
      fail(`第 ${run} 次：应用没有记下这次开会话（${candidate.title}）`);
    }
    const opening = {
      run,
      title: candidate.title,
      id: candidate.id,
      pressedAt,
      coveredMs: record.coveredMs,
      domMs,
      lift: record.lift,
      rule: record.rule,
      ticks: record.ticks,
      heldTicks: record.heldTicks,
      bytes: record.bytes,
      screenTail: record.screenTail,
      firstContentMs,
      leafId,
    };
    report.runs.push(opening);
    report.windows.push(
      `run ${run}: ${candidate.title} -> ${record.coveredMs} ms, lift=${record.lift}, rule=${record.rule}, ticks=${record.ticks}, held=${record.heldTicks}, dom=${domMs}, firstContent=${firstContentMs}`,
    );

    if (domMs === null) fail(`第 ${run} 次：DOM 采样没看到过渡层收起`);
    if (record.screenTail !== null && record.screenTail.trim().length === 0) {
      report.blankLift = (report.blankLift ?? 0) + 1;
    }
    if (Math.abs(domMs - record.coveredMs) > TOLERANCE_MS) {
      fail(
        `第 ${run} 次：两个时钟对不上，DOM ${domMs}ms 与记录 ${record.coveredMs}ms（容差 ${TOLERANCE_MS}ms）`,
      );
    }

    // Whatever ran to resume it started here, so it ends here; the tab goes back too, or the next run
    // cannot press that row (a row whose tab exists is only brought forward).
    await sleep(1500);
    started = resumeProcesses(candidate.id).filter((pid) => !pidsBefore.includes(pid));
    opening.resumedPids = started;
    await evaluate(`(() => {
      const before = ${JSON.stringify(beforeTabs)};
      const opened = [...document.querySelectorAll("[data-tab-id]")]
        .map((el) => el.getAttribute("data-tab-id"))
        .filter((id) => !before.includes(id));
      for (const el of document.querySelectorAll("[data-tab-id]")) {
        if (!opened.includes(el.getAttribute("data-tab-id"))) continue;
        const chip =
          el.querySelector('[role="button"][aria-label]') ??
          el.querySelector('[role="button"][data-no-drag]:last-child');
        if (chip) chip.click();
      }
      return opened.length;
    })()`);
    for (const pid of started) {
      try {
        execFileSync("taskkill.exe", ["/F", "/PID", String(pid)], {
          stdio: "ignore",
        });
      } catch {
        // Already gone, which is the usual case: the tab's own close ended it.
      }
    }
    await sleep(1200);
  }

  const durations = report.runs.map((r) => r.coveredMs).sort((a, b) => a - b);
  const median = durations[Math.floor(durations.length / 2)] ?? null;
  report.summary = {
    runs: durations.length,
    blankLifts: report.blankLift ?? 0,
    minMs: durations[0] ?? null,
    medianMs: median,
    maxMs: durations.at(-1) ?? null,
    lifts: [...new Set(report.runs.map((r) => r.lift))],
    rules: [...new Set(report.runs.map((r) => r.rule))],
  };
  console.log(
    `BASELINE: 遮罩用时 ${durations.join(" / ")} ms（中位 ${median}），收起原因 ${JSON.stringify(report.summary.lifts)}，命中的规则 ${JSON.stringify(report.summary.rules)}；每次都用 DOM 与应用的记录两个时钟互相核对过（容差 ${TOLERANCE_MS}ms）。`,
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    `FAIL: ${error instanceof ProbeFailure ? error.message : String(error?.message ?? error)}`,
  );
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  try {
    await evaluate(
      `(() => { if (window.__openingProbe?.timer) clearInterval(window.__openingProbe.timer); delete window.__openingProbe; return true; })()`,
    );
  } catch {
    // A dead webview is not what this run is about.
  }
  await sleep(600);
  socket.close();
}
