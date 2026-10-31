// Does a session row stay on screen while the list is being re-read?
//
// Reported by the person using this build (2026-10-31): four sessions in the list keep disappearing
// and coming back. The mechanism it was reported against rebuilds the list out of the sources that
// have answered so far, and the sources answer at very different times on this machine (opencode in
// 50 to 150 ms, pi in 2.6 to 3.3 s, a distro in 0.8 to 1.0 s), so the slow source's rows leave the
// list for the seconds between the two.
//
// A row leaving and coming back is only a fault when nothing said it should: a source that failed
// answers for its rows (they are dropped until it answers again), and a deleted session is gone for
// good. So this probe reads each read's **own answer** - the ids it returned - through the channel
// the reads really use, and can therefore say which source a row belongs to and whether that
// source's read was still in flight, or failed, when the row left. That is the difference between
// the bug and the design.
//
// The IPC is a `fetch` to the IPC scheme, not `window.__TAURI_INTERNALS__.invoke`: that property is
// own, non-writable and non-configurable, so wrapping it is silently dropped (measured; see
// `session-reading-cold-start.mjs`). Nothing here writes to the stores or asks for a destructive
// action; `--refresh` presses the panel's own Refresh button, which is the same read the backend's
// watcher starts on every write.
//
// Usage (dev instance with --remote-debugging-port=9222):
//   node scripts/dev/probes/session-rows-stable.mjs --seconds=180
//   node scripts/dev/probes/session-rows-stable.mjs --seconds=120 --refresh=2 --gap=25
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const seconds = Number(arg("seconds", "120"));
const refresh = Number(arg("refresh", "0"));
const gapSeconds = Number(arg("gap", "20"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find(
  (t) =>
    t.type === "page" &&
    (t.url.endsWith("1420/") || t.url.endsWith("tauri.localhost/")),
);
if (!page) {
  console.error("没找到主窗口的 page 目标（dev 起来了吗？）");
  process.exit(2);
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
  new Promise((res, rej) => {
    const i = id++;
    pending.set(i, (m) =>
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result),
    );
    socket.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (body) => {
  const r = await send("Runtime.evaluate", {
    expression: `(${body})()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
    );
  }
  return r.result.value;
};

/**
 * The instrument, installed in the page.
 *
 * Two records, on one clock: every read of the session stores (when it was asked, when it answered,
 * which ids it answered with, and the error when there was one), and every change to the set of rows
 * on screen, sampled every 20 ms. Rows are read by their `data-session-id`, which is the id the
 * store gave them, so a row can be matched to the read that returned it.
 */
const INSTALL = `() => {
  // A run of this probe leaves its instrument in the page, and a second run then reports the first
  // run's records as its own (measured: a 70 second run printed reads from five minutes earlier, and
  // the two runs' presses could not be told apart). Installing here means installing, not joining.
  const previous = window.__rowsStableProbe;
  if (previous) clearInterval(previous.timer);
  const probe = { installedAt: Math.round(performance.now()), samples: 0, reads: [], changes: [] };
  window.__rowsStableProbe = probe;

  const rowIds = () =>
    [...document.querySelectorAll("[data-session-id]")].map((r) => r.getAttribute("data-session-id"));
  const reading = () => {
    const empty = document.querySelector("[data-session-empty]");
    const header = [...document.querySelectorAll("button")]
      .map((b) => (b.getAttribute("aria-label") ?? "") + "|" + (b.textContent ?? "").trim())
      .find((x) => /刷新|Refresh|读取中/.test(x));
    return { empty: empty ? empty.getAttribute("data-session-empty") : null, header: header ?? null };
  };

  let last = null;
  const sample = () => {
    try {
      probe.samples += 1;
      const rows = rowIds();
      const state = reading();
      const key = JSON.stringify([rows, state]);
      if (key === last) return;
      // The previous sample, as the pair it was stored as. Reading it as an object here (before.rows)
      // threw on the first change, and an exception inside a setInterval callback is silent: the
      // sampler went on counting samples, recorded no further changes, and looked like a run in which
      // the list never moved (measured: the header demonstrably changed from 读取中 to 刷新 under it).
      const before = last === null ? [[], null] : JSON.parse(last);
      probe.changes.push({
        at: Math.round(performance.now()),
        drawn: rows.length,
        empty: state.empty,
        header: state.header,
        gone: before[0].filter((r) => !rows.includes(r)),
        added: rows.filter((r) => !before[0].includes(r)),
      });
      last = key;
    } catch (error) {
      // Reported rather than swallowed: a sampler that fails has to fail the run, not the list.
      probe.sampleError = String(error) + " @" + Math.round(performance.now());
      clearInterval(probe.timer);
    }
  };
  sample();
  probe.timer = setInterval(sample, 20);

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    if (!/agent_sessions_list/.test(url)) return originalFetch.apply(this, arguments);
    let args = null;
    try {
      args = init && typeof init.body === "string" ? JSON.parse(init.body) : null;
    } catch {}
    const entry = {
      at: Math.round(performance.now()),
      tool: (args && args.tool) ?? null,
      distro: (args && args.distro) ?? null,
      settled: null,
      ids: null,
      error: null,
    };
    probe.reads.push(entry);
    return originalFetch.apply(this, arguments).then(
      (response) => {
        entry.settled = Math.round(performance.now());
        // The answer itself, so a row can be matched to the read that returned it. It is read off a
        // clone and **in the background**: awaiting it here holds this response until the body is
        // done, and the caller of this fetch *is* this response - measured, every read after the
        // instrument was installed never reached the panel, the list stayed at the rows the mount
        // read had drawn, and the header said 读取中 until the run ended. An instrument that can stop
        // the thing it measures reports the absence of the bug it is looking for.
        try {
          response.clone().text().then(
            (text) => {
              entry.bodyAt = Math.round(performance.now());
              // The ids are taken as text rather than by parsing: the payload is the wire shape, and
              // a row's id is the only thing needed from it.
              entry.ids = [...text.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
            },
            (error) => {
              entry.error = "body: " + String(error);
            },
          );
        } catch (error) {
          entry.error = "clone: " + String(error);
        }
        return response;
      },
      (error) => {
        entry.settled = Math.round(performance.now());
        entry.error = String(error);
        throw error;
      },
    );
  };
  return "installed";
}`;

/**
 * One press of the panel's own Refresh, found by its label rather than by position, and reported by
 * what it says, so a run where the button was not there says so instead of looking like a pass.
 */
const PRESS_REFRESH = `() => {
  const button = [...document.querySelectorAll("button")].find((b) =>
    /刷新|Refresh|读取中/.test((b.getAttribute("aria-label") ?? "") + (b.textContent ?? "")),
  );
  if (!button) return "没找到刷新按钮";
  if (button.disabled) return "按钮是禁用的（有读取没结束）";
  button.click();
  return "已点刷新";
}`;

/**
 * What the refresh button says. `loading` disables it, and a click on a disabled button does
 * nothing at all - so a press that is not checked against this reports itself as a press while
 * starting no read (measured: the first run of this probe printed a press at t+0.04s that began no
 * read, because the panel was still reading the list it had just been mounted with).
 */
const BUTTON_STATE = `() => {
  const button = [...document.querySelectorAll("button")].find((b) =>
    /刷新|Refresh|读取中/.test((b.getAttribute("aria-label") ?? "") + (b.textContent ?? "")),
  );
  return button
    ? { text: (button.textContent ?? "").trim(), disabled: button.disabled === true }
    : null;
}`;

const PAGE_NOW = `() => Math.round(performance.now())`;

/** Wait for the button to say something, at most `timeoutMs`. `null` means it never did. */
const waitForButton = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await evaluate(BUTTON_STATE);
    if (state && predicate(state)) return state;
    if (Date.now() > deadline) return null;
    await sleep(200);
  }
};

await evaluate(INSTALL);
// The list reads itself when it mounts, so the first press has to wait for that read: pressing while
// it is in flight changes nothing, and a run that counts such a press as a trigger measures a read
// nobody asked for.
const quiet = await waitForButton((state) => !state.disabled, 60_000);
console.log(
  quiet
    ? `列表空闲了（按钮说「${quiet.text}」），可以开始按键。`
    : "按钮一直不可用：没有任何一次读取在这一次跑里结束，所以这一次什么也没按。",
);

const started = Date.now();
const presses = [];
for (let i = 0; i < refresh; i += 1) {
  if (i > 0) await sleep(gapSeconds * 1000);
  if (!(await waitForButton((state) => !state.disabled, 60_000))) {
    presses.push({ at: await evaluate(PAGE_NOW), said: "按钮不可用，没按", landed: false });
    continue;
  }
  const said = await evaluate(PRESS_REFRESH);
  const landed = (await waitForButton((state) => state.disabled, 10_000)) !== null;
  presses.push({ at: await evaluate(PAGE_NOW), said, landed });
}
const remaining = Math.max(0, seconds * 1000 - (Date.now() - started));
await sleep(remaining);

const probe = await evaluate(`() => {
  const p = window.__rowsStableProbe;
  clearInterval(p.timer);
  return JSON.stringify(p);
}`);
const data = JSON.parse(probe);
const t0 = data.installedAt;
const rel = (ms) => ((ms - t0) / 1000).toFixed(2);

console.log(`采样 ${data.samples} 次 / ${seconds} 秒（每 20 ms），期间 ${data.reads.length} 次会话库读取。`);
if (data.sampleError) {
  console.log(`\n不通过：采样器自己出错了，这一次的结论无效 —— ${data.sampleError}`);
  socket.close();
  process.exit(2);
}
for (const press of presses)
  console.log(
    `  t+${rel(press.at)}s ${press.said}${press.landed === false ? "（这一次没有触发读取）" : ""}`,
  );

console.log("\n--- 每次读取（源 / 耗时 / 回了哪些行）---");
for (const read of data.reads) {
  const source = `${read.distro ?? "本机"}::${read.tool}`;
  const took = read.settled === null ? "未答" : `${read.settled - read.at}ms`;
  const ids = read.ids === null ? "" : ` 回了 ${read.ids.length} 行`;
  const err = read.error ? ` 失败 ${read.error.slice(0, 60)}` : "";
  console.log(`  t+${rel(read.at)}s ${source.padEnd(22)} ${took.padStart(7)}${ids}${err}`);
}

console.log("\n--- 每一次「画出来的行集变了」---");
for (const change of data.changes) {
  const line =
    `  t+${rel(change.at)}s 画了 ${change.drawn} 行  empty=${change.empty}  header=${change.header}`;
  console.log(line);
  if (change.gone.length || change.added.length) {
    // Which source each row belongs to, from the read that last returned it: that is what turns
    // "a row left" into "a row left while its own source was still being read".
    const sourceOf = {};
    for (const read of data.reads) {
      for (const id of read.ids ?? []) {
        sourceOf[id] = `${read.distro ?? "本机"}::${read.tool}`;
      }
    }
    const inFlight = data.reads.filter(
      (r) => r.settled === null || r.settled > change.at,
    );
    if (change.gone.length) {
      console.log(
        `        走了 ${change.gone.map((rid) => `${rid.slice(-8)}@${sourceOf[rid] ?? "来源未知"}`).join(", ")}` +
          `   当时还在读：${inFlight.length === 0 ? "无" : inFlight.map((r) => `${r.distro ?? "本机"}::${r.tool}`).join(", ")}`,
      );
    }
    if (change.added.length) {
      console.log(`        来了 ${change.added.map((rid) => rid.slice(-8)).join(", ")}`);
    }
  }
}

/**
 * The probe's own falsification, before any claim about the list: a press is a non-silent read, so it
 * has to move the header between 「刷新」 and 「读取中」 at least once. A run whose presses are known to
 * have landed and which recorded no change at all is a run whose sampler failed, not a run in which
 * the list held still - which is exactly how this probe first reported two passes.
 */
const landedPresses = presses.filter((press) => press.landed !== false);
if (landedPresses.length > 0 && data.changes.length <= 1) {
  console.log(
    "\n不通过：按键确实触发了读取，采样器却一次变化都没记到 —— 按一次刷新必然让顶栏在「刷新」和「读取中」之间走一趟，所以这一次的结论无效。",
  );
  socket.close();
  process.exit(2);
}

/**
 * The verdict: a row that left and came back is the reported fault, unless its source was failing at
 * the time (then dropping its rows is the intended behaviour) or the list was told to read from a
 * different set of sources.
 */
const back = new Map();
const flickers = [];
const deletions = [];
data.changes.forEach((change, index) => {
  for (const rowId of change.gone) back.set(rowId, { goneAt: change.at, index });
  for (const rowId of change.added) {
    const left = back.get(rowId);
    if (!left) continue;
    back.delete(rowId);
    const window = data.changes.slice(left.index, index + 1);
    // A failed read for this row's source in the same window explains its absence by design.
    const failed = data.reads.some(
      (r) =>
        r.error !== null &&
        r.at >= left.goneAt - 500 &&
        r.at <= change.at + 500 &&
        (r.ids ?? []).length === 0,
    );
    const entry = { rowId, goneAt: left.goneAt, backAt: change.at, missingMs: change.at - left.goneAt, failed };
    (failed ? deletions : flickers).push(entry);
  }
});

console.log(`\n一共画到过 ${new Set(data.changes.flatMap((c) => c.added)).size} 个不同的行 id。`);
if (flickers.length === 0) {
  console.log("没有出现「行消失后又回来」（同一行，期间没有任何读取失败）。");
} else {
  console.log(`\n不通过：${flickers.length} 次行消失后又回来：`);
  for (const f of flickers) {
    console.log(
      `  - ${f.rowId} t+${rel(f.goneAt)}s 消失，t+${rel(f.backAt)}s 回来（缺 ${f.missingMs}ms）`,
    );
  }
}
if (deletions.length > 0) {
  console.log(`\n另有 ${deletions.length} 次行消失后回来，期间有读取失败（按设计应当如此）：`);
  for (const d of deletions) console.log(`  - ${d.rowId} 缺 ${d.missingMs}ms`);
}
socket.close();
process.exit(flickers.length > 0 ? 1 : 0);
