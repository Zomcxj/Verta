// The two awaits that hold up the first render, and what they actually cost.
//
// `main.tsx` awaits `pty_close_all` and then `get_launch_dir` before it renders React at all, so the
// interface cannot appear until both have come back. They are awaited one after the other, which is
// only worth paying for if the second one needs the first one's answer. Neither does: one reaps
// orphaned terminal sessions, the other reads the directory the launch was handed, and both are
// trivial on the backend, so whatever time they take is the IPC round trip itself.
//
// This measures that round trip rather than arguing about it: every IPC call is recorded from the
// first frame with the moment it was asked and the moment it came back, and the report says how long
// the two took on the critical path, whether they overlapped, and when the interface first drew
// anything.
//
// Usage (start the probe first, then the application):
//   node scripts/dev/probes/startup-awaits.mjs --wait=180000 --observe=40000
//   node scripts/dev/probes/startup-awaits.mjs --reload
//
// Attaching to a running application and reloading is not the same measurement: the IPC channel is
// already warm, so the numbers are far smaller. `--wait` without `--reload` is the cold one.
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const waitMs = Number(arg("wait", "180000"));
const observeMs = Number(arg("observe", "40000"));
const reload = process.argv.includes("--reload");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Installed before the page boots, so the first IPC call is seen.
 *
 * The command name is the last segment of the request URL and the arguments are the request body,
 * which is how the IPC carries a call. The render is detected by watching the root element for its
 * first child: that is exactly the thing the two awaits are holding up.
 */
const INSTRUMENT = `
(() => {
  if (window.__startupProbe) return;
  const probe = {
    installedAt: Math.round(performance.now()),
    readyStateAtInstall: document.readyState,
    calls: [],
    dragRegionAt: null,
    elementCountAtRender: null,
  };
  window.__startupProbe = probe;

  const original = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    if (!url.includes("ipc.localhost")) return original.apply(this, arguments);
    const entry = {
      at: Math.round(performance.now()),
      cmd: decodeURIComponent(url.replace(/^.*ipc\\.localhost\\//, "").split("?")[0]),
      settled: null,
    };
    probe.calls.push(entry);
    return original.apply(this, arguments).then(
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

  // The render is detected by the window's own drag region, which only the interface draws. The root
  // element is no use for this: index.html already has a child inside it, so "the root has content"
  // is true before any script runs.
  const poll = () => {
    if (probe.dragRegionAt === null && document.querySelector("[data-tauri-drag-region]")) {
      probe.dragRegionAt = Math.round(performance.now());
      probe.elementCountAtRender = document.querySelectorAll("*").length;
      return;
    }
    setTimeout(poll, 5);
  };
  poll();
})();
`;

const MAIN_URL = /(localhost:1420|tauri\.localhost)\/?$/;

async function findTarget(deadline) {
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
      const page = targets.find((t) => t.type === "page" && MAIN_URL.test(t.url));
      if (page) return page;
    } catch {
      // Not up yet.
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
  new Promise((res, rej) => {
    const i = id++;
    pending.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m)));
    socket.send(JSON.stringify({ id: i, method, params }));
  });
const pageEval = async (body) => {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => {\n${body}\n})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description ?? "eval failed");
  }
  return r.result.result.value;
};

const report = { reload, waitMs, observeMs };
try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });
  report.installedInCurrentDocument = await pageEval(
    `${INSTRUMENT}\nreturn Boolean(window.__startupProbe);`,
  );
  if (reload) await send("Page.reload", { ignoreCache: false });
  await sleep(observeMs);

  const raw = await pageEval(`
    const probe = window.__startupProbe;
    if (!probe) return null;
    return JSON.stringify({
      installedAt: probe.installedAt,
      readyStateAtInstall: probe.readyStateAtInstall,
      calls: probe.calls,
      dragRegionAt: probe.dragRegionAt,
      elementCountAtRender: probe.elementCountAtRender,
    });
  `);
  if (raw === null) throw new Error("页面里没有采样器：这次运行什么都没测到");
  const measured = JSON.parse(raw);

  const at = (cmd) => measured.calls.find((c) => c.cmd === cmd) ?? null;
  const closeAll = at("pty_close_all");
  const launchDir = at("get_launch_dir");
  const span = (call) => (call && call.settled !== null ? call.settled - call.at : null);

  report.installedAt = measured.installedAt;
  report.readyStateAtInstall = measured.readyStateAtInstall;
  report.callCount = measured.calls.length;
  report.callsBeforeRender =
    measured.dragRegionAt === null
      ? null
      : measured.calls.filter((c) => c.at <= measured.dragRegionAt).length;
  report.ptyCloseAll = closeAll
    ? { at: closeAll.at, settled: closeAll.settled, ms: span(closeAll) }
    : null;
  report.getLaunchDir = launchDir
    ? { at: launchDir.at, settled: launchDir.settled, ms: span(launchDir) }
    : null;
  report.serialGapMs =
    closeAll && launchDir ? launchDir.at - (closeAll.settled ?? closeAll.at) : null;
  // What the two cost the critical path: from the moment the first was asked to the moment the last
  // came back. Issued one after the other this is their sum plus the gap; issued together it is
  // shorter, and by how much is the answer. The sum of the two durations is reported next to it so
  // an overlap that did not help is visible rather than averaged away.
  report.pairSpanMs =
    closeAll && launchDir && closeAll.settled !== null && launchDir.settled !== null
      ? Math.max(closeAll.settled, launchDir.settled) - Math.min(closeAll.at, launchDir.at)
      : null;
  report.overlapped =
    closeAll && launchDir ? launchDir.at < (closeAll.settled ?? Number.POSITIVE_INFINITY) : null;
  report.sumOfDurationsMs =
    closeAll && launchDir && span(closeAll) !== null && span(launchDir) !== null
      ? span(closeAll) + span(launchDir)
      : null;
  report.dragRegionAt = measured.dragRegionAt;
  report.elementCountAtRender = measured.elementCountAtRender;
  report.renderAfterAwaitsMs =
    launchDir && launchDir.settled !== null && measured.dragRegionAt !== null
      ? measured.dragRegionAt - launchDir.settled
      : null;
  report.firstCalls = measured.calls.slice(0, 8);

  console.log(JSON.stringify(report, null, 1));

  const problems = [];
  if (!closeAll) problems.push("没记到 pty_close_all");
  if (!launchDir) problems.push("没记到 get_launch_dir");
  if (measured.dragRegionAt === null) problems.push("界面一直没画出来（没有拖拽区）");
  if (problems.length > 0) {
    console.error(`\n没有通过：${problems.join("；")}`);
    process.exit(1);
  }
  console.log(
    `\n通过：pty_close_all ${span(closeAll)}ms、get_launch_dir ${span(launchDir)}ms，` +
      `两个${report.overlapped ? "同时发" : "串行发"}，关键路径 ${report.pairSpanMs}ms` +
      `（两个耗时相加是 ${report.sumOfDurationsMs}ms），` +
      `第二个回来到界面画出来还有 ${report.renderAfterAwaitsMs}ms。`,
  );
} catch (error) {
  report.error = String(error?.message ?? error);
  console.log(JSON.stringify(report, null, 1));
  process.exit(1);
} finally {
  socket.close();
}
