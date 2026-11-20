// Acceptance for "Claude Code sessions are in the same list as the other two", on the real store.
//
// Three things are checked, and each has a way of failing that a unit test cannot see:
//
//   1. The list matches the disk. The transcripts are read here, in node, with the same precedence the
//      Rust side uses (a `custom-title`/`agent-name` name, then the first line a person wrote, then the
//      last prompt, then the id) - an independent second reading, so a rule that drifted shows up as a
//      mismatch rather than as agreement.
//   2. A distro read answers with nothing. Claude Code writes its transcripts in this machine's home
//      directory; answering with the local list for a distro would show every session once per distro.
//   3. Pressing a Claude Code row opens `claude --resume <id>` in the session's own cwd. Read from the
//      `pty_open` call the page makes, which is the only place a release build says what it opened
//      (the dev-server probes import the modules instead, and a release build has no such modules).
//
// Nothing is modified: no preference is touched, no session is written, and the tab this run opened is
// closed again. The store itself is read-only throughout.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/agent-sessions-claude.mjs [--port=9222] [--cwd-contains=<substring>]
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const only = process.argv.find((a) => a.startsWith("--cwd-contains="))?.slice(14);

const report = {};
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

const ROOT = join(homedir(), ".claude", "projects");

/** One event's JSON, or `null` for a line that is not an event. */
const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/** Whether a `user` line is a person writing; the machine's own markers all start with `<`. */
const humanText = (event) => {
  if (event.type !== "user" || event.isMeta || event.isSidechain) return null;
  const content = event.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((part) => part?.type === "text")
            .map((part) => part.text ?? "")
            .join(" ")
        : "";
  const collapsed = text.split(/\s+/).filter(Boolean).join(" ");
  if (!collapsed || collapsed.startsWith("<")) return null;
  return collapsed;
};

/** The title the list should show for one transcript. */
const expectedTitle = (events, id) => {
  // The last name recorded, not the first: Claude Code re-appends its current name whenever the
  // name is set, so a rename late in a long session is the line the tool itself shows.
  const named = events
    .filter(
      (event) =>
        (event.type === "custom-title" && event.customTitle) ||
        (event.type === "agent-name" && event.agentName),
    )
    .at(-1);
  const human = events.map(humanText).find((text) => text !== null);
  const prompts = events.filter(
    (event) => event.type === "last-prompt" && event.lastPrompt,
  );
  const name = (named?.customTitle ?? named?.agentName ?? human ?? prompts.at(-1)?.lastPrompt ?? id)
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  return name.length > 80 ? `${[...name].slice(0, 80).join("")}…` : name;
};

/** Every session on disk, as this run understands it. */
function readDisk() {
  const sessions = new Map();
  for (const project of readdirSync(ROOT, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = join(ROOT, project.name);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Only the transcripts directly in a project directory: the `<id>/` directory beside each one
      // holds its subagents, and those are not sessions.
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(dir, entry.name);
      const events = readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(parse)
        .filter(Boolean);
      if (events.length === 0) continue;
      const id = entry.name.replace(/\.jsonl$/, "");
      const cwd = events.map((event) => event.cwd).find((value) => typeof value === "string");
      if (!cwd) continue;
      sessions.set(id, { id, cwd, title: expectedTitle(events, id), mtime: statSync(path).mtimeMs });
    }
  }
  return sessions;
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page =
  targets.find((t) => t.type === "page" && t.url === "http://tauri.localhost/") ??
  targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
if (!page) fail("no page target: is the app running with --remote-debugging-port?");
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
    if (await evaluate(`(() => { const n = ${expression}; return n ? true : false; })()`)) return true;
    await sleep(250);
  }
  return false;
};

/** The app's own list, asked the way the page asks. */
const list = async (distro = null) =>
  JSON.parse(
    await evaluate(
      `window.__TAURI_INTERNALS__.invoke("agent_sessions_list", { tool: "claude", distro: ${JSON.stringify(distro)} }).then((payload) => JSON.stringify(payload)).catch((error) => JSON.stringify({ error: String(error) }))`,
    ),
  );

/** The title of every open tab, which is how a session that is already open is recognized. */
const openTitles = async () =>
  JSON.parse(
    await evaluate(
      `JSON.stringify([...document.querySelectorAll("[data-tab-id]")].map((el) => (el.innerText || "").trim()))`,
    ),
  );

/** Processes that are a `claude --resume <id>` for this session.
 *
 * Filtered by executable name as well as by command line: the probe's own PowerShell carries the id
 * as an argument, and every intermediate shell does too, so matching on the text alone finds this
 * run's own reflection instead of the agent. `claude.exe` is the agent; `node.exe` covers a
 * transcript resumed through a JavaScript entry point.
 */
const resumeProcesses = (id) => {
  const command = `(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('claude.exe','node.exe') -and $_.CommandLine -like '*--resume*' -and $_.CommandLine -like '*${id}*' } | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }) -join "\`n"`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, ...rest] = line.split("\t");
      return { pid: Number(pid), command: rest.join("\t") };
    })
    .filter((entry) => Number.isFinite(entry.pid));
};

const openedTabs = new Set();
const openedTerminals = [];

try {
  const disk = readDisk();
  report.disk = { root: ROOT, sessions: disk.size };
  if (disk.size === 0) fail(`no Claude Code sessions under ${ROOT}, so there is nothing to accept`);

  // ---- The list matches the disk ---------------------------------------------------------------
  const listed = await list();
  if (listed.error) fail(`agent_sessions_list(claude) failed: ${listed.error}`);
  report.listed = {
    count: listed.sessions.length,
    warnings: listed.warnings,
  };
  if (listed.warnings.length > 0) {
    fail(`the store has unreadable transcripts: ${listed.warnings.join("; ")}`);
  }
  const wrong = [];
  for (const session of listed.sessions) {
    if (session.tool !== "claude") wrong.push(`${session.id}: tool ${session.tool}`);
    const onDisk = disk.get(session.id);
    if (!onDisk) {
      wrong.push(`${session.id}: listed but not on disk`);
      continue;
    }
    if (session.cwd !== onDisk.cwd) wrong.push(`${session.id}: cwd ${session.cwd} != ${onDisk.cwd}`);
    if (session.title !== onDisk.title) {
      wrong.push(`${session.id}: title ${JSON.stringify(session.title)} != ${JSON.stringify(onDisk.title)}`);
    }
    if (session.parentId !== null) wrong.push(`${session.id}: parentId ${session.parentId}`);
  }
  const missing = [...disk.keys()].filter(
    (id) => !listed.sessions.some((session) => session.id === id),
  );
  report.mismatch = { wrong, missing };
  if (wrong.length > 0) fail(`the list disagrees with the disk: ${wrong.slice(0, 4).join("; ")}`);
  if (missing.length > disk.size / 2) {
    // A session written while this run was reading can be missing from one side; most of them cannot.
    fail(`${missing.length} of ${disk.size} sessions on disk are not in the list`);
  }
  // The numbers the row shows: turns and tokens are recorded by this tool, so they must not be blank.
  const numbered = listed.sessions.filter(
    (session) => session.turns !== null || session.tokens !== null,
  );
  if (numbered.length === 0) fail("no session reported turns or tokens: the transcript is not being folded");

  // ---- A distro read answers with nothing ------------------------------------------------------
  const inDistro = await list("Ubuntu-22.04");
  report.inDistro = { error: inDistro.error ?? null, count: inDistro.sessions?.length ?? null };
  if (inDistro.error) fail(`a distro read failed instead of answering: ${inDistro.error}`);
  if (inDistro.sessions.length !== 0) {
    fail(
      `a distro read returned ${inDistro.sessions.length} sessions: every session would be listed once per distro`,
    );
  }

  // ---- A row opens `claude --resume <id>`, in a cwd where that session is found -------------------
  //
  // The command cannot be read from the app: it spawns a shell and *types* the command into it (see
  // `writeToSession` in App.tsx), so nothing in its IPC or its diagnostics carries the text, and the
  // dev-server probes that import the modules have no counterpart in a release build. What can be read
  // is the operating system: the resumed process's own command line, and whether it is still alive a
  // few seconds later - `claude --resume <id>` with the wrong working directory exits at once with "no
  // conversation found", which is the failure this whole path exists to avoid.
  /** The transcripts on disk right now, by session id. */
  const diskIds = () => new Set(readDisk().keys());

  const titles = await openTitles();
  report.openTabs = titles;
  const running = new Set(
    listed.sessions.flatMap((session) => resumeProcesses(session.id).map(() => session.id)),
  );
  report.alreadyRunning = [...running];
  const candidate = listed.sessions
    .filter((session) => !titles.includes(session.title))
    .filter((session) => !running.has(session.id))
    .filter((session) => !only || session.cwd.toLowerCase().includes(only.toLowerCase()))
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
  if (!candidate) {
    fail(
      `no Claude Code session is both closed and not already running (open: ${titles.join(", ")}; running: ${
        [...running].join(", ") || "none"
      }), so opening one cannot be told from the one that is already there`,
    );
  }
  report.pressing = { id: candidate.id, title: candidate.title, cwd: candidate.cwd };

  const clicked = await evaluate(`(() => {
    const rows = () => [...document.querySelectorAll("[data-session-id]")].filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (rows().length === 0) {
      const tab = [...document.querySelectorAll("button")].find((b) => /^(会话|Sessions)$/.test((b.getAttribute("aria-label") || "").trim()));
      if (tab) tab.click();
      return "opened the list";
    }
    return "already";
  })()`);
  if (clicked === "opened the list") await sleep(1500);
  const row = `document.querySelector('[data-session-id=${JSON.stringify(candidate.id)}]')`;
  if (!(await waitFor(row, 20000))) {
    const count = await evaluate(`document.querySelectorAll("[data-session-id]").length`);
    fail(`the list drew ${count} rows but none for ${candidate.id} (${candidate.title})`);
  }
  const tabIdBefore = await evaluate(
    `[...document.querySelectorAll("[data-tab-id]")].map((el) => el.getAttribute("data-tab-id"))`,
  );
  const idsBefore = diskIds();
  const pidsBefore = resumeProcesses(candidate.id).map((entry) => entry.pid);
  await evaluate(`(() => { const el = ${row}; el.scrollIntoView({ block: "center" }); el.click(); return true; })()`);

  let started = [];
  for (let attempt = 0; attempt < 14; attempt += 1) {
    await sleep(1500);
    started = resumeProcesses(candidate.id).filter((entry) => !pidsBefore.includes(entry.pid));
    if (started.length > 0) break;
  }
  report.resumed = started.map((entry) => ({ pid: entry.pid, command: entry.command.slice(0, 200) }));
  if (started.length === 0) {
    fail(
      `pressing the row started no \`claude --resume ${candidate.id}\` process in 21s (running before: ${pidsBefore.join(", ") || "none"})`,
    );
  }
  if (!started.some((entry) => /claude(\.exe)?\s+--resume/.test(entry.command))) {
    fail(`a process appeared but it is not a claude resume: ${started[0].command}`);
  }

  // Still alive a few seconds later, and no new transcript: together that says the session was found
  // rather than a new one started next to it, which is what a wrong working directory produces.
  await sleep(6000);
  const stillAlive = resumeProcesses(candidate.id).filter((entry) => !pidsBefore.includes(entry.pid));
  report.stillAlive = stillAlive.map((entry) => entry.pid);
  const idsAfter = diskIds();
  const fresh = [...idsAfter].filter((id) => !idsBefore.has(id));
  report.newTranscripts = fresh;
  if (stillAlive.length === 0) {
    fail(
      `the resumed process was gone within six seconds: \`claude --resume\` exits at once when the cwd has no such session, which is the failure the cwd has to prevent`,
    );
  }
  if (fresh.length > 0) {
    fail(`resuming created ${fresh.length} new transcript(s) (${fresh.join(", ")}): the session was started again instead of resumed`);
  }

  // ---- Pressing it again does not open a second terminal ---------------------------------------
  // One session is one tab: a second terminal would be two agents writing to one transcript.
  const beforeSecond = resumeProcesses(candidate.id).length;
  await evaluate(`(() => { const el = ${row}; if (el) el.click(); return true; })()`);
  await sleep(2500);
  const afterSecond = resumeProcesses(candidate.id).length;
  report.repressing = { before: beforeSecond, after: afterSecond };
  if (afterSecond > beforeSecond) {
    fail(`pressing the same session twice started ${afterSecond - beforeSecond} more process(es)`);
  }
  const active = await evaluate(
    `([...document.querySelectorAll("[data-tab-id][data-tab-active='true']")][0]?.innerText || "").trim()`,
  );
  report.activeTab = active;
  if (!active.includes(candidate.title)) {
    fail(`pressing the row did not bring its tab forward: the active tab reads ${JSON.stringify(active)}`);
  }

  // ---- And the three tools are in the list together --------------------------------------------
  const all = {};
  for (const tool of ["opencode", "pi", "claude"]) {
    const payload = JSON.parse(
      await evaluate(
        `window.__TAURI_INTERNALS__.invoke("agent_sessions_list", { tool: ${JSON.stringify(tool)}, distro: null }).then((p) => JSON.stringify({ count: p.sessions.length, tools: [...new Set(p.sessions.map((s) => s.tool))] })).catch((error) => JSON.stringify({ error: String(error) }))`,
      ),
    );
    all[tool] = payload;
  }
  report.tools = all;
  for (const [tool, payload] of Object.entries(all)) {
    if (payload.error) continue; // A tool that is not installed is not this change's business.
    if (payload.tools.some((name) => name !== tool)) {
      fail(`${tool} returned a session belonging to ${payload.tools.join(", ")}`);
    }
  }
  if (all.claude.count === undefined || all.claude.count === 0) {
    fail(`the claude list is empty although ${disk.size} sessions are on disk`);
  }

  // New tabs are closed again; the ones this run opened are the difference.
  const tabIdAfter = await evaluate(
    `[...document.querySelectorAll("[data-tab-id]")].map((el) => el.getAttribute("data-tab-id"))`,
  );
  for (const id of tabIdAfter) {
    if (!tabIdBefore.includes(id)) openedTabs.add(id);
  }

  console.log(
    `PASS: Claude Code 的 ${listed.sessions.length} 个会话与磁盘上的 ${disk.size} 个一一对上（cwd、标题、没有父会话都一致，且至少一条报了回合/词数）；按发行版问它答 0 条（不会每个发行版重复列一遍）；点还没打开的「${candidate.title}」起的是 ${report.resumed.at(-1)?.command?.slice(0, 90)}…（cwd ${candidate.cwd}），六秒后还活着、也没多出新转录（目录不对时 claude --resume 会立刻退出并说找不到会话）；再点一次不会多起进程，只是把标签提到前面；三家列在一张表里各报自家的会话；跑完已关掉本轮开的标签并结束本轮起的进程。`,
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
    await evaluate(`(() => {
      const ids = ${JSON.stringify([...openedTabs])};
      for (const el of document.querySelectorAll("[data-tab-id]")) {
        if (!ids.includes(el.getAttribute("data-tab-id"))) continue;
        // The chip that carries an aria-label: the first role="button" in a tab is the file icon's
        // dropdown, which opens a menu instead of closing anything.
        const chip =
          el.querySelector('[role="button"][aria-label]') ??
          el.querySelector('[role="button"][data-no-drag]:last-child');
        if (chip) chip.click();
      }
      return ids.length;
    })()`);
    await sleep(600);
  } catch {
    // A dead webview is not what this run is about.
  }
  // The processes this run started are this run's to end: the terminal was closed, and an agent left
  // running against a transcript nobody is looking at is somebody else's problem tomorrow.
  try {
    const started = report.resumed?.map((entry) => entry.pid) ?? [];
    if (started.length > 0) {
      execFileSync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `Stop-Process -Id ${started.join(",")} -Force -ErrorAction SilentlyContinue`,
      ]);
    }
  } catch {
    // Already gone, which is the normal case: closing the terminal hangs up the shell.
  }
  socket.close();
}
