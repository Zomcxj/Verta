// Do the opening transitions survive a tab switch, with several sessions starting at once?
//
// Two reports, one probe, because they are the same mechanism seen twice.
//
//   "切标签再切回加载动画消失变成终端命令" - switching tabs and coming back showed a bare terminal with the
//   resume command on it. The layer must not follow the reader to another tab, the starting pane's
//   pixels must stay hidden while the reader is away, and the layer must be up again on return.
//
//   "连续点击多个会话，只有最后一个切标签切回加载动画还在，其它的都变成了终端指令" - with several starts
//   pending, only the newest kept its cover. The state was one entry, so each new start replaced the
//   previous one and the older panes were uncovered while their sessions were still starting. Every
//   start now keeps its own entry, so every one of them has to survive the same switch.
//
// Nothing is typed: sessions from the list are resumed, the switch happens while their covers are up,
// and the tabs are closed again at the end.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/session-opening-tab-switch.mjs [--port=9222] [--tool=claude] [--runs=3]
import { execFileSync } from "node:child_process";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const tool = process.argv.find((a) => a.startsWith("--tool="))?.slice(7) ?? "claude";
const runs = Number(process.argv.find((a) => a.startsWith("--runs="))?.slice(7) ?? "3");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page =
  targets.find((t) => t.type === "page" && t.url === "http://tauri.localhost/") ??
  targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
if (!page) fail("no page target for the main window: is the app running with --remote-debugging-port?");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve);
  socket.addEventListener("error", (e) => reject(new Error(String(e?.message ?? e))));
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
    const what = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
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
const json = (expression) =>
  evaluate(`JSON.stringify(${expression})`).then((raw) => JSON.parse(raw));

/** Processes resuming this session, so the run can end the agents it started. */
const resumeProcesses = (id) => {
  const command = `(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('claude.exe','node.exe','pi.exe','opencode.exe') -and $_.CommandLine -like '*${id}*' } | ForEach-Object { "$($_.ProcessId)" }) -join " "`;
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8" })
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
  json(`[...document.querySelectorAll("[data-tab-id]")].map((el) => Number(el.getAttribute("data-tab-id")))`);

const selectedTab = () =>
  evaluate(`(() => {
    const el = document.querySelector('[data-tab-id][data-tab-active="true"]');
    return el ? Number(el.getAttribute("data-tab-id")) : null;
  })()`);

/**
 * Select a tab the way a reader does.
 *
 * `click()` is not enough: the chip is a Radix `TabsTrigger`, whose activation runs from a real
 * pointer sequence, and a synthetic `click` alone left the tab unselected - which made an earlier run
 * of this probe report that the layer followed the reader when the reader had never moved.
 */
const clickTab = async (id) => {
  const box = await json(`(() => {
    const el = document.querySelector('[data-tab-id="${id}"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (box === null) return false;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  await sleep(150);
  return true;
};

/** Everything the DOM can say about one leaf's coverage, in one read. */
const coverage = (leafId) =>
  json(`(() => {
    const pane = document.querySelector('[data-pane-leaf="${leafId}"]');
    const paneRoot = pane?.firstElementChild ?? null;
    return {
      layerUp: document.querySelector("[data-session-opening]") !== null,
      paneFound: pane !== null,
      paneOpacity: paneRoot ? getComputedStyle(paneRoot).opacity : null,
    };
  })()`);

const report = { tool, runs, opened: [], verdict: null };
let pidsBefore = [];
const openedTabs = [];

try {
  await send("Page.bringToFront");
  await sleep(400);

  // The session list has to be on screen for a row to be pressed.
  if (!(await evaluate(`document.querySelectorAll("[data-session-id]").length > 0`))) {
    await evaluate(`(() => {
      const rail = [...document.querySelectorAll("button")].find((b) => /^(会话|Sessions)$/.test((b.getAttribute("aria-label") || "").trim()));
      rail?.click();
      return true;
    })()`);
    await sleep(1500);
  }

  // The string has to be built inside the page, after the await: `JSON.stringify` outside it would
  // serialize the pending promise, which arrives as `{}` and reads as "no sessions".
  const listed = JSON.parse(
    await evaluate(
      `window.__TAURI_INTERNALS__.invoke("agent_sessions_list", { tool: ${JSON.stringify(tool)}, distro: null })
        .then((p) => JSON.stringify({ sessions: p.sessions.map((s) => ({ id: s.id, title: s.title })) }))
        .catch((error) => JSON.stringify({ error: String(error) }))`,
    ),
  );
  if (listed.error) fail(`agent_sessions_list(${tool}) failed: ${listed.error}`);

  // Only rows the list actually draws: a session the list filters out cannot be pressed, and asking
  // for one made an earlier run report "the list has no row" about a session that is not on it.
  const drawn = new Set(
    await json(
      `[...document.querySelectorAll("[data-session-id]")].map((el) => el.getAttribute("data-session-id"))`,
    ),
  );
  if (drawn.size === 0) fail("the session list is not drawing any rows");
  const openTitles = await json(
    `[...document.querySelectorAll("[data-tab-id]")].map((el) => (el.innerText || "").trim())`,
  );
  const candidates = listed.sessions
    .filter((s) => drawn.has(s.id) && !openTitles.includes(s.title))
    .slice(0, runs);
  if (candidates.length === 0) fail(`no ${tool} row is both drawn and not already a tab`);

  const beforeTabs = await tabIds();
  const beforeLeaves = await json(`window.__vertaTerm ? window.__vertaTerm().ghosttySessions.map((s) => s.leafId) : []`);

  // Press the rows one after another, the way the report did: several starts overlap.
  for (const candidate of candidates) {
    const row = `document.querySelector('[data-session-id=${JSON.stringify(candidate.id)}]')`;
    if (!(await waitFor(row, 20000))) fail(`the list has no row for ${candidate.id}`);
    pidsBefore = [...pidsBefore, ...resumeProcesses(candidate.id)];
    await evaluate(`(() => { const el = ${row}; el.scrollIntoView({ block: "center" }); el.click(); return true; })()`);
    await sleep(700);
  }

  // Which tab and leaf each press created, in order.
  const tabsNow = await tabIds();
  const leavesNow = await json(`window.__vertaTerm ? window.__vertaTerm().ghosttySessions.map((s) => s.leafId) : []`);
  const newTabs = tabsNow.filter((id) => !beforeTabs.includes(id));
  const newLeaves = leavesNow.filter((id) => !beforeLeaves.includes(id));
  if (newTabs.length !== candidates.length || newLeaves.length !== candidates.length) {
    fail(`expected ${candidates.length} new tab(s) and leaf/leaves, got ${newTabs.length} and ${newLeaves.length}`);
  }
  report.opened = candidates.map((candidate, i) => ({
    id: candidate.id,
    title: candidate.title,
    tabId: newTabs[i],
    leafId: newLeaves[i],
  }));

  // Every start still has to be covered, not only the newest: this is the second report.
  const problems = [];
  for (const opened of report.opened) {
    const state = await coverage(opened.leafId);
    opened.opened = state;
    if (!state.layerUp && opened === report.opened.at(-1)) {
      problems.push(`${opened.title}: no layer after pressing it`);
    }
    if (state.paneOpacity !== "0") {
      problems.push(`${opened.title}: pane opacity ${state.paneOpacity} right after opening, expected 0`);
    }
  }

  // A tab to switch to: any tab that is none of the ones just opened.
  const other = tabsNow.find((id) => !newTabs.includes(id));
  if (other === undefined) fail("there is no other tab to switch to; open one and rerun");
  report.switchedTo = other;

  if (!(await clickTab(other))) fail(`could not press tab ${other}`);
  await sleep(700);
  if ((await selectedTab()) !== other) fail(`the tab did not change: selected ${await selectedTab()}, wanted ${other}`);

  for (const opened of report.opened) {
    opened.away = await coverage(opened.leafId);
    if (opened.away.layerUp) problems.push(`${opened.title}: the layer followed the reader to another tab`);
    if (opened.away.paneOpacity !== "0") {
      problems.push(`${opened.title}: pane opacity ${opened.away.paneOpacity} while away, expected 0`);
    }
  }

  // Back to each one in turn: its layer has to be up and its pane still hidden.
  for (const opened of report.opened) {
    if (!(await clickTab(opened.tabId))) fail(`could not press tab ${opened.tabId}`);
    await sleep(700);
    const selected = await selectedTab();
    if (selected !== opened.tabId) fail(`the tab did not come back: selected ${selected}, wanted ${opened.tabId}`);
    opened.back = await coverage(opened.leafId);
    if (!opened.back.layerUp) problems.push(`${opened.title}: coming back did not bring the layer back`);
    if (opened.back.paneOpacity !== "0") {
      problems.push(`${opened.title}: pane opacity ${opened.back.paneOpacity} after coming back, expected 0`);
    }
  }

  report.verdict = problems.length === 0 ? "ok" : problems;
} catch (error) {
  report.verdict = `failed: ${error instanceof Error ? error.message : String(error)}`;
} finally {
  // Close the tabs this run opened and end the agents it started. Nothing else is touched.
  for (const opened of report.opened) {
    try {
      const box = await json(`(() => {
        const el = document.querySelector('[data-tab-id="${opened.tabId}"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      if (box === null) continue;
      // Middle click closes a tab in this strip; the close button only appears on hover.
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "middle", clickCount: 1 });
      }
      openedTabs.push(opened.tabId);
      await sleep(600);
    } catch {
      /* cleanup is best effort */
    }
  }
  report.closedTabs = openedTabs;
  report.endedProcesses = [];
  for (const opened of report.opened) {
    for (const pid of resumeProcesses(opened.id).filter((id) => !pidsBefore.includes(id))) {
      try {
        execFileSync("taskkill.exe", ["/PID", String(pid), "/F"], { stdio: "ignore" });
        report.endedProcesses.push(pid);
      } catch {
        /* already gone */
      }
    }
  }
  socket.close();
  console.log(JSON.stringify(report, null, 1));
}
